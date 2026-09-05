// Fixture: stands in for a file inside packages/agent. Deliberately violates
// B2 (CONTRACTS.md §2) by importing the payment layer from model
// orchestration code.
import { chargeRail } from "@repo/payments";

export function negotiate() {
  return chargeRail;
}
