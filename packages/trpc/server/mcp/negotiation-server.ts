import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";

import { createContext, type Context } from "../context";
import { serverRouter } from "../index";
import { negotiationInputSchemas } from "../routes/negotiation/route";

/**
 * TICKET-205 — MCP server adapter.
 *
 * A THIN adapter that re-exposes the buyer-agent-facing negotiation
 * procedures (`packages/trpc/server/routes/negotiation/route.ts`, TICKET-204)
 * as Model Context Protocol tools. A third-party buyer agent that speaks MCP
 * can point at the public `/mcp` endpoint and negotiate end to end with no
 * bespoke integration — it gets the same five calls the tRPC / OpenAPI
 * surface already offers.
 *
 * WHAT THIS IS NOT
 *  - Not a new capability. Every tool below is a 1:1 pass-through to an
 *    existing `negotiationRouter` procedure via `serverRouter.createCaller`,
 *    using that procedure's own frozen input schema
 *    (`negotiationInputSchemas`). No business logic, no state, no economics
 *    live here. The frozen buyer-facing contract (CONTRACTS.md §9) is still
 *    the single source of truth for behaviour, and this file adds nothing to
 *    it.
 *  - Not a wider surface. Only the negotiation procedures are exposed. The
 *    merchant console (`merchantRouter`) and the audit ledger
 *    (`auditRouter`) are deliberately absent — a buyer agent has no business
 *    reaching either.
 *
 * LEAK DISCIPLINE (CONTRACTS.md §9)
 *  Tool names, descriptions and input schemas below never mention — and must
 *  never come to mention — a floor price, an available budget figure, a
 *  per-deal cap, a concession-curve value, or an offer tier. The procedures
 *  they call already guarantee no such value is serialized in a response
 *  (`packages/trpc/server/routes/negotiation/public-mappers.ts`,
 *  `packages/trpc/tests/response-shape.test.ts`); this file must not
 *  reintroduce one in prose. Error text is filtered too (see
 *  {@link callProcedure}). `packages/trpc/tests/mcp-negotiation.test.ts`
 *  pins all of this.
 *
 *  Tool results are the procedure's own return value serialized as JSON text
 *  — no MCP `outputSchema` is declared. The procedure outputs are already
 *  narrow, explicit zod (`route.ts`), and re-declaring them here as MCP
 *  output schemas would only add a second definition to drift from. A thin
 *  adapter forwards; it does not re-specify.
 */

/** How the adapter obtains a request context (the `{ db }` a tRPC caller
 *  needs). Defaults to the real {@link createContext}; tests inject one bound
 *  to the sibling test database. */
export type McpContextFactory = () => Promise<Context> | Context;

const SERVER_INFO = {
  name: "merchant-growth-agent",
  version: "1.0.0",
} as const;

const INSTRUCTIONS = [
  "Negotiate a checkout deal on behalf of a buyer.",
  "Typical flow: call open_negotiation for a session, then propose one or more",
  "times to exchange messages and receive offers, then accept_offer to take an",
  "offer or respond_to_offer to decline it and continue, or to walk away.",
  "Whether a session can be negotiated at all, and every price in every offer,",
  "is decided server-side — you cannot set an amount.",
].join(" ");

export function createNegotiationMcpServer(
  createRequestContext: McpContextFactory = createContext,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  /** Runs one procedure call behind a fresh caller and renders its result as
   *  MCP tool content.
   *
   *  A thrown `TRPCError` is a deliberate, buyer-safe refusal (an unknown
   *  session, a call in the wrong order, or the autonomous-payment
   *  `NOT_IMPLEMENTED` gate) — its message is surfaced as a tool error so a
   *  stock model gets a clean, readable reason. Anything else is an internal
   *  fault whose message may carry implementation detail; it is collapsed to
   *  a generic string, exactly as tRPC's own error formatter masks a
   *  non-`TRPCError` on the HTTP surface. Negotiation refusals that the
   *  procedures *return* normally (`NOT_AT_RISK`, `ROUND_LIMIT_REACHED`, …)
   *  come back as ordinary results carrying their `reasonCode`. */
  async function callProcedure(
    run: (caller: ReturnType<typeof serverRouter.createCaller>) => Promise<unknown>,
  ): Promise<CallToolResult> {
    try {
      const caller = serverRouter.createCaller(await createRequestContext());
      const value = await run(caller);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      const message =
        err instanceof TRPCError
          ? err.message
          : "The negotiation service could not handle that request.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  server.registerTool(
    "get_session_context",
    {
      title: "Get session context",
      description:
        "Return the checkout basket for a session and whether that session is currently open to negotiation.",
      inputSchema: negotiationInputSchemas.getSessionContext.shape,
    },
    ({ sessionId }) => callProcedure((caller) => caller.negotiation.getSessionContext({ sessionId })),
  );

  server.registerTool(
    "open_negotiation",
    {
      title: "Open a negotiation",
      description:
        "Start negotiating a session on behalf of a buyer agent. Returns a negotiationId on success, " +
        "or a reason code if the session is not open to negotiation.",
      inputSchema: negotiationInputSchemas.openNegotiation.shape,
    },
    ({ sessionId, buyerAgentId }) =>
      callProcedure((caller) => caller.negotiation.openNegotiation({ sessionId, buyerAgentId })),
  );

  server.registerTool(
    "propose",
    {
      title: "Send a message / counter",
      description:
        "Send the buyer's message for this round. The merchant agent replies, and may return an offer " +
        "(exact basket, commitments, total and expiry) or end the negotiation.",
      inputSchema: negotiationInputSchemas.propose.shape,
    },
    ({ negotiationId, message }) =>
      callProcedure((caller) => caller.negotiation.propose({ negotiationId, message })),
  );

  server.registerTool(
    "respond_to_offer",
    {
      title: "Decline an offer or walk away",
      description:
        "Respond to the pending offer without accepting it: DECLINE_AND_CONTINUE keeps negotiating, " +
        "WALK_AWAY ends the negotiation.",
      inputSchema: negotiationInputSchemas.respondToOffer.shape,
    },
    ({ negotiationId, offerId, response }) =>
      callProcedure((caller) =>
        caller.negotiation.respondToOffer({ negotiationId, offerId, response }),
      ),
  );

  server.registerTool(
    "accept_offer",
    {
      title: "Accept an offer",
      description:
        "Accept the pending offer. Returns a payment handle the human buyer authorizes — this never " +
        "captures or charges a payment.",
      inputSchema: negotiationInputSchemas.acceptOffer.shape,
    },
    ({ negotiationId, offerId }) =>
      callProcedure((caller) => caller.negotiation.acceptOffer({ negotiationId, offerId })),
  );

  return server;
}
