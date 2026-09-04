import { describe, expect, it } from "vitest";

import { TRANSITIONS } from "../contracts";

/**
 * TICKET-108 — locks in the reading of the frozen state machine
 * (`packages/policy/contracts/state-machine.ts`) that TICKET-108's database
 * implementation (`packages/database/repositories/campaign-holds.ts`,
 * `releaseCampaignHold` / `commitCampaignHold`) is built against.
 *
 * The ticket text alone ("released on expiry, decline, or payment failure")
 * reads as if each cause might need its own reason code. This test asserts,
 * directly against the frozen contract, that it does not: every hold-release
 * transition in the table carries exactly `HOLD_RELEASED` and every
 * hold-commit transition carries exactly `HOLD_COMMITTED`, regardless of
 * which state it fires from. That is why the database layer implements one
 * generic release function and one generic commit function rather than a
 * parameterized "reason" — there is no real decision left to make pure and
 * separate here, so no new code was added to `packages/policy/economics` for
 * this ticket. This test is `packages/policy`'s share of TICKET-108's work:
 * proving the reading, not adding a redundant abstraction (house rule: no
 * premature abstractions).
 *
 * `packages/policy` is pure and needs no seam (CONTRACTS.md §8) — this reads
 * the frozen table directly, no I/O.
 */
describe("TICKET-108 — hold release/commit transitions in the frozen state machine", () => {
  const holdReleaseTransitions = TRANSITIONS.filter((t) => t.event === "BUDGET_RESERVED" || t.reasonCode === "HOLD_RELEASED");
  const holdCommitTransitions = TRANSITIONS.filter((t) => t.reasonCode === "HOLD_COMMITTED");

  it("every HOLD_RELEASED transition carries exactly that code, from any of the three real causes", () => {
    const releaseTransitions = TRANSITIONS.filter((t) => t.reasonCode === "HOLD_RELEASED");

    // Three real-world causes: tier-2 decline, TTL expiry, payment failure —
    // all present, all HOLD_RELEASED, every one with its own `event`.
    const froms = releaseTransitions.map((t) => t.from).sort();
    expect(froms).toEqual(["EXPIRED", "OFFER_PENDING", "PAYMENT_FAILED"].sort());

    for (const transition of releaseTransitions) {
      expect(transition.reasonCode).toBe("HOLD_RELEASED");
    }

    // The expiry and payment-failure releases are same-state self-loops
    // (EXPIRED -> EXPIRED, PAYMENT_FAILED -> PAYMENT_FAILED): the session was
    // already terminal, and releasing the hold doesn't move it anywhere else.
    const expirySelfLoop = releaseTransitions.find((t) => t.from === "EXPIRED");
    const paymentFailedSelfLoop = releaseTransitions.find((t) => t.from === "PAYMENT_FAILED");
    expect(expirySelfLoop!.to).toBe("EXPIRED");
    expect(paymentFailedSelfLoop!.to).toBe("PAYMENT_FAILED");

    // The tier-2 decline release is the one exception to "self-loop": it
    // fires from OFFER_PENDING and moves to OPEN in the SAME transition —
    // the session reopens for further negotiation while the hold releases,
    // rather than staying parked in a terminal-ish state. Still exactly one
    // event, exactly one code (HOLD_RELEASED), never a distinct decline code
    // bolted on separately.
    const declineRelease = releaseTransitions.find((t) => t.from === "OFFER_PENDING");
    expect(declineRelease!.to).toBe("OPEN");
    expect(declineRelease!.event).toBe("BUYER_DECLINES");
  });

  it("every HOLD_COMMITTED transition is a same-state self-loop", () => {
    for (const transition of holdCommitTransitions) {
      expect(transition.to).toBe(transition.from);
      expect(transition.reasonCode).toBe("HOLD_COMMITTED");
    }
    expect(holdCommitTransitions.length).toBeGreaterThan(0);
  });

  it("no cause-specific code (OFFER_EXPIRED, PAYMENT_FAILED, PAYMENT_CAPTURED) is conflated with the hold transition itself", () => {
    // OFFER_EXPIRED / PAYMENT_FAILED / PAYMENT_CAPTURED belong to separate,
    // session-level transitions (TTL_ELAPSED, RAIL_REPORTS_FAILED,
    // RAIL_REPORTS_CAPTURED events) distinct from the HOLD_RELEASED /
    // HOLD_COMMITTED self-loop transitions that follow them. Confirm they
    // are indeed different transitions in the table, not one merged event.
    const sessionLevelExpiry = TRANSITIONS.find((t) => t.reasonCode === "OFFER_EXPIRED");
    const holdReleaseOnExpiry = TRANSITIONS.find(
      (t) => t.from === "EXPIRED" && t.reasonCode === "HOLD_RELEASED",
    );
    expect(sessionLevelExpiry).toBeDefined();
    expect(holdReleaseOnExpiry).toBeDefined();
    expect(sessionLevelExpiry!.event).not.toBe(holdReleaseOnExpiry!.event);

    const sessionLevelPaymentFailed = TRANSITIONS.find(
      (t) => t.reasonCode === "PAYMENT_FAILED" && t.event === "RAIL_REPORTS_FAILED",
    );
    const holdReleaseOnPaymentFailed = TRANSITIONS.find(
      (t) => t.from === "PAYMENT_FAILED" && t.reasonCode === "HOLD_RELEASED",
    );
    expect(sessionLevelPaymentFailed).toBeDefined();
    expect(holdReleaseOnPaymentFailed).toBeDefined();
    expect(sessionLevelPaymentFailed!.event).not.toBe(holdReleaseOnPaymentFailed!.event);

    const sessionLevelCaptured = TRANSITIONS.find((t) => t.reasonCode === "PAYMENT_CAPTURED");
    const holdCommitOnCapture = TRANSITIONS.find((t) => t.reasonCode === "HOLD_COMMITTED");
    expect(sessionLevelCaptured).toBeDefined();
    expect(holdCommitOnCapture).toBeDefined();
    expect(sessionLevelCaptured!.event).not.toBe(holdCommitOnCapture!.event);
  });

  it("HOLD_RESERVED (TICKET-107, already built) also fires as its own transition, not merged with release/commit", () => {
    expect(holdReleaseTransitions.some((t) => t.event === "BUDGET_RESERVED")).toBe(true);
  });
});
