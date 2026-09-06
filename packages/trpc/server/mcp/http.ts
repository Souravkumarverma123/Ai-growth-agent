import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createNegotiationMcpServer, type McpContextFactory } from "./negotiation-server";

/**
 * Stateless Streamable-HTTP handler for the MCP negotiation surface
 * (TICKET-205).
 *
 * One fresh `McpServer` + transport per request (`sessionIdGenerator:
 * undefined`): a negotiation's entire state already lives in Postgres, keyed
 * by `sessionId` / `negotiationId`, so there is nothing to keep in MCP
 * session memory. A stateless endpoint is the simplest thing that survives an
 * API restart or a second replica, and it keeps this adapter genuinely thin.
 *
 * The host app owns transport wiring — this returns a plain
 * `(req, res, parsedBody) => Promise<void>` so `apps/api` can mount it on
 * `POST /mcp` without `packages/trpc` (the transport layer) taking a
 * dependency on a logger or an HTTP framework. `onError` lets the host log a
 * transport-level fault with its own logger.
 */
export function createMcpHttpHandler(
  createRequestContext?: McpContextFactory,
  onError?: (error: unknown) => void,
) {
  return async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const server = createNegotiationMcpServer(createRequestContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      // Fail closed with a structured JSON-RPC error — never a silent no-op.
      // The fault is handed to the host's `onError` so it stays observable
      // (CONTRACTS.md §6).
      onError?.(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error handling MCP request" },
            id: null,
          }),
        );
      }
    }
  };
}
