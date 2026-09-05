// Fixture: stands in for a file inside packages/policy. Deliberately violates
// B1 (CONTRACTS.md §2) by reaching into the payment rail from the engine.
import { chargeRail } from "@repo/payments";

export function settle() {
  return chargeRail;
}
