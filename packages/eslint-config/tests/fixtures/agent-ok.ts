// Fixture: stands in for compliant code inside packages/agent. No payments
// import, no database import — its only engine entry point is mintOffer.
import { mintOffer } from "@repo/policy";

export function negotiate(sessionId: string) {
  return mintOffer(sessionId);
}
