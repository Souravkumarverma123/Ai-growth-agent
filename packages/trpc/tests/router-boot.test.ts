import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "trpc-to-openapi";

import { serverRouter } from "../server";

/**
 * Regression test for ISSUE-001.
 *
 * The router tree used to fail at module load unless three GOOGLE_OAUTH_*
 * environment variables were set, because the auth router pulled in a user
 * service whose env schema required them. Every agent and the demo machine hit
 * it on first run.
 *
 * Importing the router at all is the assertion: this file runs with DATABASE_URL
 * and nothing else, so if a future change reintroduces a required environment
 * variable behind the router tree, this test fails at import time.
 */
describe("the server router boots with only DATABASE_URL configured", () => {
  it("requires no OAuth environment variables", () => {
    expect(process.env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(process.env.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(process.env.GOOGLE_OAUTH_REDIRECT_URI).toBeUndefined();
    expect(serverRouter).toBeDefined();
  });

  it("generates the public OpenAPI document the buyer agents integrate against", () => {
    const doc = generateOpenApiDocument(serverRouter, {
      title: "Merchant Growth Agent",
      version: "1.0.0",
      baseUrl: "http://localhost:4000/api",
    });

    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain("/negotiation/open");
    expect(paths).toContain("/negotiation/accept");
    expect(paths).toContain("/merchant/campaign-budget");
    expect(paths).toContain("/audit/session/{sessionId}");
  });

  it("no longer exposes the removed authentication surface", () => {
    const doc = generateOpenApiDocument(serverRouter, {
      title: "Merchant Growth Agent",
      version: "1.0.0",
      baseUrl: "http://localhost:4000/api",
    });

    expect(Object.keys(doc.paths ?? {})).not.toContain("/authentication/supported-providers");
  });
});
