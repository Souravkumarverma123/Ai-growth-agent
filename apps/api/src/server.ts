import express from "express";
import { logger } from "@repo/logger";
import cors from "cors";

import * as trpcExpress from "@trpc/server/adapters/express";
import { generateOpenApiDocument, createOpenApiExpressMiddleware } from "trpc-to-openapi";
import { apiReference } from "@scalar/express-api-reference";

import { serverRouter, createContext } from "@repo/trpc/server";
import { createMcpHttpHandler } from "@repo/trpc/server/mcp";

import { env } from "./env";

export const app = express();
const openApiDocument = generateOpenApiDocument(serverRouter, {
  title: "Streamyst OpenAPI",
  version: "1.0.0",
  baseUrl: env.BASE_URL.concat("/api"),
});

if (env.NODE_ENV !== "prod") {
  // ISSUE-006: a wildcard origin cannot be combined with credentialed
  // requests (the browser blocks it outright) — `origin: true` reflects the
  // requesting origin instead, which is what `credentials: true` requires.
  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
}

app.use(express.json());

app.get("/", (req, res) => {
  return res.json({ message: "Streamyst is up and running..." });
});

app.get("/health", (req, res) => {
  return res.json({ message: "Streamyst server is healthy", healthy: true });
});

logger.debug(`openapi.json: ${env.BASE_URL}/openapi.json`);
app.get("/openapi.json", (req, res) => {
  return res.json(openApiDocument);
});

logger.debug(`docs: ${env.BASE_URL}/docs`);
app.use("/docs", apiReference({ url: "/openapi.json" }));

// TICKET-205 — MCP server adapter. A stateless Streamable-HTTP endpoint that
// re-exposes the buyer-facing negotiation procedures as MCP tools, so a
// third-party buyer agent can negotiate against this system with no bespoke
// integration. Thin adapter — all behaviour is still the tRPC procedures
// (`@repo/trpc/server/mcp`). The Scalar reference at `/docs` documents the
// equivalent HTTP surface.
const handleMcpRequest = createMcpHttpHandler(undefined, (err) =>
  logger.error("MCP request failed", { err }),
);
logger.debug(`mcp: ${env.BASE_URL}/mcp`);
app.post("/mcp", (req, res) => {
  void handleMcpRequest(req, res, req.body);
});

// The endpoint is stateless (no SSE session to resume, no session to delete),
// so the GET and DELETE halves of the Streamable HTTP spec do not apply here.
const mcpMethodNotAllowed = (req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. The MCP endpoint is stateless; use POST." },
    id: null,
  });
app.get("/mcp", mcpMethodNotAllowed);
app.delete("/mcp", mcpMethodNotAllowed);

app.use(
  "/api",
  createOpenApiExpressMiddleware({
    router: serverRouter,
    createContext,
  }),
);

app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({
    router: serverRouter,
    createContext,
  }),
);

export default app;
