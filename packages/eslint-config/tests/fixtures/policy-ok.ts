// Fixture: stands in for compliant code inside packages/policy. No model
// SDK, no payments import — proves B1 does not false-positive on ordinary
// deterministic-engine code.
import { z } from "zod";

const inputSchema = z.object({ offerId: z.string().uuid() });

export function scoreCandidate(input: unknown) {
  return inputSchema.parse(input);
}
