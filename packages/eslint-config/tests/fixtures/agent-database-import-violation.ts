// Fixture: stands in for a file inside packages/agent. Deliberately violates
// B2 (CONTRACTS.md §2) by writing offer/policy state directly instead of
// going through mintOffer.
import { db } from "@repo/database";

export function negotiate() {
  return db;
}
