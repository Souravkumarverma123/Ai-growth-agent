import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import { auditEventsTable, negotiationSessionsTable, offersTable } from "@repo/database/schema";

import { seedNegotiationSession } from "./support/negotiation-fixtures";

/**
 * TICKET-205 — MCP server adapter.
 *
 * Required test: an end-to-end negotiation driven entirely through the MCP
 * surface. Nothing here calls a tRPC procedure directly — every step goes
 * `MCP client -> tool call -> adapter -> serverRouter.createCaller` against a
 * real Postgres (CONTRACTS.md §8's primary seam).
 *
 * Two transports are exercised: an in-memory linked pair (fast, the bulk of
 * the assertions) and the real `POST /mcp` HTTP endpoint via a Node server
 * wrapping `createMcpHttpHandler` — the actual deliverable — driven by the
 * SDK's `StreamableHTTPClientTransport`, the same transport a stock model's
 * MCP client uses.
 *
 * The one mock is `@repo/payments`'s `createOrder`, for the reasons
 * `negotiation-route.test.ts` documents: the real implementation makes a live
 * Razorpay HTTP call and binds to the `@repo/database` singleton rather than
 * the sibling test database (ISSUE-012). `insertTestOrderForOffer`
 * (`./support/negotiation-fixtures`) inserts a real `orders` row into this
 * test's own database so the downstream read still finds one.
 */
vi.mock("@repo/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/payments")>();
  const { insertTestOrderForOffer: insertOrder } = await import("./support/negotiation-fixtures");
  return {
    ...actual,
    createOrder: vi.fn((offerId: string) => insertOrder(offerId)),
  };
});

const { createNegotiationMcpServer } = await import("../server/mcp");
const { createMcpHttpHandler } = await import("../server/mcp");

// The negotiation procedures need a context bound to the sibling test
// database, not the production singleton `createContext` would hand them.
const testContextFactory = async () => ({ db: await getTestDb() });

async function connectInMemoryClient(): Promise<Client> {
  const server = createNegotiationMcpServer(testContextFactory);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-buyer-agent", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Starts the real stateless `POST /mcp` handler on an ephemeral port. */
async function startHttpMcpServer(): Promise<{ url: URL; close: () => Promise<void> }> {
  const handle = createMcpHttpHandler(testContextFactory);
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      void handle(req, res, raw.length ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every tool call in this adapter returns a single text block of JSON (the
 *  procedure's own return value). */
function parseToolResult(result: { content: unknown[] }): unknown {
  const [block] = result.content as Array<{ type: string; text?: string }>;
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`unexpected MCP tool result shape: ${JSON.stringify(result)}`);
  }
  return JSON.parse(block.text);
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  return parseToolResult(await client.callTool({ name, arguments: args }));
}

describe("TICKET-205 — MCP negotiation surface", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("exposes exactly the buyer-facing negotiation tools, and their descriptions leak no policy internals", async () => {
    const client = await connectInMemoryClient();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      ["accept_offer", "get_session_context", "open_negotiation", "propose", "respond_to_offer"].sort(),
    );

    // No merchant-console or audit-ledger tool ever reaches a buyer agent.
    expect(names).not.toContain("get_policy");
    expect(names).not.toContain("get_session_ledger");

    // CONTRACTS.md §9 — nothing the buyer can read may reveal a floor, a
    // budget figure, a per-deal cap, a concession curve, or an offer tier.
    const surface = JSON.stringify(tools).toLowerCase();
    for (const forbidden of ["floor", "budget", "per-deal", "per_deal", "perdeal", "concession", "curve", "tier"]) {
      expect(surface).not.toContain(forbidden);
    }

    await client.close();
  });

  it("drives a full negotiation open -> propose -> decline -> propose -> accept to a payment handle, never a captured payment", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "AT_RISK" });
    const client = await connectInMemoryClient();

    const opened = (await callTool(client, "open_negotiation", {
      sessionId,
      buyerAgentId: "buyer-agent-1",
    })) as { opened: boolean; reasonCode: string };
    expect(opened.opened).toBe(true);
    expect(opened.reasonCode).toBe("NEGOTIATION_OPENED");

    const firstOffer = (await callTool(client, "propose", {
      negotiationId: sessionId,
      message: "Can you do better on this cart?",
    })) as { terminal: boolean; offer: { offerId: string } | null };
    expect(firstOffer.terminal).toBe(false);
    expect(firstOffer.offer).not.toBeNull();

    // Decline and keep negotiating — the multi-round path through MCP.
    const declined = (await callTool(client, "respond_to_offer", {
      negotiationId: sessionId,
      offerId: firstOffer.offer!.offerId,
      response: "DECLINE_AND_CONTINUE",
    })) as { terminal: boolean; reasonCode: string };
    expect(declined.terminal).toBe(false);
    expect(["TIER1_REFUSED_BY_BUYER", "HOLD_RELEASED"]).toContain(declined.reasonCode);

    const secondOffer = (await callTool(client, "propose", {
      negotiationId: sessionId,
      message: "Still a bit high for me.",
    })) as { terminal: boolean; offer: { offerId: string; totalMinor: number; currency: string } | null };
    expect(secondOffer.offer).not.toBeNull();
    expect(secondOffer.offer!.currency).toBe("INR");
    expect(secondOffer.offer!.totalMinor).toBeGreaterThan(0);

    const accepted = (await callTool(client, "accept_offer", {
      negotiationId: sessionId,
      offerId: secondOffer.offer!.offerId,
    })) as {
      accepted: boolean;
      reasonCode: string;
      paymentHandle: { orderId: string; railOrderId: string; amountMinor: number; currency: string } | null;
    };
    expect(accepted.accepted).toBe(true);
    expect(accepted.reasonCode).toBe("OFFER_ACCEPTED");
    expect(accepted.paymentHandle).not.toBeNull();
    expect(accepted.paymentHandle!.currency).toBe("INR");
    expect(accepted.paymentHandle!.railOrderId).toMatch(/^rzp_test_order_/);
    // A payment HANDLE, never a capture: no capture-shaped field exists.
    expect(accepted.paymentHandle).not.toHaveProperty("captured");
    expect(accepted.paymentHandle).not.toHaveProperty("status");

    const db = await getTestDb();
    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, sessionId));
    expect(session!.state).toBe("AWAITING_PAYMENT");

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, sessionId));
    const reasonCodes = events.map((e) => e.reasonCode);
    expect(reasonCodes).toContain("NEGOTIATION_OPENED");
    expect(reasonCodes).toContain("OFFER_ACCEPTED");
    expect(reasonCodes).toContain("ORDER_CREATED");

    await client.close();
  });

  it("completes a negotiation over the real POST /mcp HTTP endpoint", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "AT_RISK" });
    const http = await startHttpMcpServer();
    const client = new Client({ name: "http-buyer-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(http.url));

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ["accept_offer", "get_session_context", "open_negotiation", "propose", "respond_to_offer"].sort(),
      );

      const opened = (await callTool(client, "open_negotiation", {
        sessionId,
        buyerAgentId: "buyer-agent-1",
      })) as { opened: boolean };
      expect(opened.opened).toBe(true);

      const proposed = (await callTool(client, "propose", {
        negotiationId: sessionId,
        message: "Can you do better?",
      })) as { offer: { offerId: string } | null };
      expect(proposed.offer).not.toBeNull();

      const accepted = (await callTool(client, "accept_offer", {
        negotiationId: sessionId,
        offerId: proposed.offer!.offerId,
      })) as { accepted: boolean; paymentHandle: { railOrderId: string } | null };
      expect(accepted.accepted).toBe(true);
      expect(accepted.paymentHandle!.railOrderId).toMatch(/^rzp_test_order_/);

      const db = await getTestDb();
      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("AWAITING_PAYMENT");
    } finally {
      await client.close();
      await http.close();
    }
  });

  it("surfaces a TRPCError refusal as a tool error, not a transport failure", async () => {
    const client = await connectInMemoryClient();

    const result = await client.callTool({
      name: "get_session_context",
      arguments: { sessionId: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block!.text).toContain("does-not-exist");

    await client.close();
  });

  it("returns an ordinary result carrying the reason code when an unflagged session is refused", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "IDLE" });
    const client = await connectInMemoryClient();

    const refused = await client.callTool({
      name: "open_negotiation",
      arguments: { sessionId, buyerAgentId: "buyer-agent-1" },
    });

    expect(refused.isError).toBeFalsy();
    const parsed = parseToolResult(refused as { content: unknown[] }) as { opened: boolean; reasonCode: string };
    expect(parsed.opened).toBe(false);
    expect(parsed.reasonCode).toBe("NOT_AT_RISK");

    // The session itself never silently advanced past IDLE.
    const db = await getTestDb();
    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, sessionId));
    expect(session!.state).toBe("IDLE");
    const [offerRow] = await db.select().from(offersTable).where(eq(offersTable.sessionId, sessionId));
    expect(offerRow).toBeUndefined();

    await client.close();
  });
});
