// Fixture: stands in for a file inside packages/policy. Deliberately violates
// B1 (CONTRACTS.md §2) by importing a model SDK into the deterministic engine.
import OpenAI from "openai";

export function scoreCandidate(client: OpenAI) {
  return client;
}
