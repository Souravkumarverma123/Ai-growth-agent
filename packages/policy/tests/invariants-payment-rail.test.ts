import { describe, expect, it } from "vitest";

import { REASON_CODES, TRANSITIONS } from "../contracts";
import type { NegotiationState, ReasonCode } from "../contracts";
import {
  computeEventHash,
  verifyChain,
  type ChainEvent,
  type HashableAuditEvent,
} from "../ledger/hash-chain";
import {
  resolveHoldCommittedTransition,
  resolveHoldReleaseTransition,
  resolveOfferAcceptTransition,
  resolvePaymentInitiationTransition,
  resolveRailReportTransition,
  type RailReportOutcome,
} from "../ledger/transition-resolver";

/**
 * TICKET-604 — the payment-and-rail-authority invariant suite, pure half
 * (PRD §9, §12, §13, §21; Settled by Q15, Q33).
 *
 * The four assertions this ticket names —
 *
 *   1. Razorpay state is authoritative — a rail-reported failure overwrites a
 *      local belief of success.
 *   2. Payment divergence is handled safely: the divergence event precedes the
 *      correction, and the hold is released exactly once.
 *   3. Autonomous payment cannot occur when disabled — the `true` branch fails
 *      closed with its own reason code, never a silent success.
 *   4. Audit events are produced correctly for every transition, and the chain
 *      verifies.
 *
 * — split across the two packages the ticket lists as `Affected`. Everything
 * that is only true because a real Postgres, a real ledger, and a real
 * scripted `RailStateSource` compose it lives in
 * `packages/payments/tests/invariants-payment-rail.test.ts` (CONTRACTS.md §8 —
 * "do not mock the database").
 *
 * This file owns the pure half: the reason a rail report can only ever be read
 * one way, the reason a divergence is recorded before it is corrected, and the
 * reason the autonomous-payment flag is a real closed boundary and not an
 * assumption. `packages/policy` is pure (CONTRACTS.md §2, §8), so there is no
 * seam and no database here — the transition resolvers
 * (`ledger/transition-resolver.ts`, TICKET-402) and the hash chain
 * (`ledger/hash-chain.ts`, TICKET-401) are called directly.
 *
 * What this adds over `transition-resolver.test.ts` (which walks every row of
 * `TRANSITIONS` once) is the *composition*: these assert the payment path's
 * invariants as emergent properties of chaining the resolvers into a whole
 * timeline and hashing it, not of any one row in isolation.
 *
 * All money is integer minor units (paise) (CONTRACTS.md §3).
 */

const SESSION_ID = "604604604-0000-4000-8000-000000000604";

/** One event's hashable content, before `buildChain` assigns sequence/prevHash. */
type EventContent = Omit<HashableAuditEvent, "sequence" | "prevHash">;

/**
 * Links a list of event contents into a valid hash chain, exactly as
 * `packages/database/repositories/audit-events.ts`'s `appendAuditEvent` builds
 * one row at a time: sequence 0, 1, 2, …; each `prevHash` is its predecessor's
 * `eventHash` (`null` for genesis); each `eventHash` is `computeEventHash` over
 * the event's own fields.
 */
function buildChain(contents: readonly EventContent[]): ChainEvent[] {
  const chain: ChainEvent[] = [];
  let prevHash: string | null = null;
  for (let sequence = 0; sequence < contents.length; sequence += 1) {
    const withoutHash: HashableAuditEvent = { ...contents[sequence]!, sequence, prevHash };
    const eventHash = computeEventHash(withoutHash);
    chain.push({ ...withoutHash, eventHash });
    prevHash = eventHash;
  }
  return chain;
}

/**
 * Turns a resolved transition into an event content record — the same shape
 * `auditParamsFromTransition` fills in production. `payload` is caller-supplied
 * evidence, irrelevant to the transition itself.
 */
function eventOf(
  transition: { event: EventContent["eventType"]; from: NegotiationState | "*"; to: NegotiationState; reasonCode: ReasonCode },
  payload: Record<string, unknown> = {},
): EventContent {
  return {
    sessionId: SESSION_ID,
    eventType: transition.event,
    fromState: transition.from === "*" ? null : transition.from,
    toState: transition.to,
    reasonCode: transition.reasonCode,
    payload,
  };
}

/**
 * A fixed, plausible lead-in for a session that has reached offer acceptance —
 * the same device `hash-chain.test.ts` uses. These pre-payment events are not
 * what this suite is about; the payment-path events appended after them are
 * every one derived from a resolver call.
 */
const PRE_PAYMENT_PREFIX: readonly EventContent[] = [
  {
    sessionId: SESSION_ID,
    eventType: "ELIGIBILITY_RULES_MATCH",
    fromState: "IDLE",
    toState: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
    payload: { cartAgeSeconds: 900 },
  },
  {
    sessionId: SESSION_ID,
    eventType: "NEGOTIATION_REQUESTED",
    fromState: "AT_RISK",
    toState: "OPEN",
    reasonCode: "NEGOTIATION_OPENED",
    payload: {},
  },
  {
    sessionId: SESSION_ID,
    eventType: "CANDIDATES_GENERATED",
    fromState: "OPEN",
    toState: "OPEN",
    reasonCode: "CANDIDATES_EVALUATED",
    payload: { evaluated: 12, feasible: 9, tier1: 4 },
  },
  {
    sessionId: SESSION_ID,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "TIER1_OFFERED",
    payload: { candidateId: "cand-bundle-1", totalMinor: 302_000 },
  },
  {
    sessionId: SESSION_ID,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "TIER1_REFUSED_BY_BUYER",
    payload: { candidateId: "cand-bundle-1" },
  },
  {
    sessionId: SESSION_ID,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "DILUTION_WITHIN_CAPS",
    payload: { candidateId: "cand-original-cart", shortfallMinor: 20_000 },
  },
  {
    sessionId: SESSION_ID,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
    payload: { holdId: "hold-1", amountMinor: 20_000 },
  },
];

const ALL_RAIL_OUTCOMES: readonly RailReportOutcome[] = ["CAPTURED", "FAILED", "CONTRADICTS_LOCAL"];

// ===========================================================================
// Invariant 1 — the rail's report is the only reading of an order's fate
// ===========================================================================

describe("INVARIANT: Razorpay state is authoritative — local belief can never override a rail report (PRD §12, §21.11)", () => {
  it("every rail outcome resolves from AWAITING_PAYMENT to exactly the state the rail reported, never the opposite", () => {
    // CAPTURED -> SETTLED, FAILED and CONTRADICTS_LOCAL -> PAYMENT_FAILED.
    // There is no outcome that lets the session land anywhere else.
    const landingByOutcome: Record<RailReportOutcome, NegotiationState> = {
      CAPTURED: "SETTLED",
      FAILED: "PAYMENT_FAILED",
      CONTRADICTS_LOCAL: "PAYMENT_FAILED",
    };
    for (const outcome of ALL_RAIL_OUTCOMES) {
      const transition = resolveRailReportTransition(outcome);
      expect(transition.from).toBe("AWAITING_PAYMENT");
      expect(transition.to).toBe(landingByOutcome[outcome]);
    }
  });

  it("a FAILED report yields PAYMENT_FAILED and never PAYMENT_CAPTURED — no argument for 'what we locally believed' even exists", () => {
    // The resolver's whole input is the rail's own outcome. There is no
    // parameter through which a local belief of success could be passed in to
    // tip the result — the same shape as eligibility taking no conversation
    // input. Calling it 50 times changes nothing.
    for (let i = 0; i < 50; i += 1) {
      const transition = resolveRailReportTransition("FAILED");
      expect(transition.reasonCode).toBe("PAYMENT_FAILED");
      expect(transition.to).toBe("PAYMENT_FAILED");
      expect(transition.reasonCode).not.toBe("PAYMENT_CAPTURED");
    }
    expect(resolveRailReportTransition).toHaveLength(1);
  });

  it("once the rail has been read, the session is terminal — no transition leaves SETTLED or PAYMENT_FAILED except a same-state hold self-loop", () => {
    for (const terminal of ["SETTLED", "PAYMENT_FAILED"] as const) {
      const leaving = TRANSITIONS.filter((t) => t.from === terminal && t.to !== terminal);
      expect(leaving).toEqual([]);
    }
  });

  it("there is no rail transition that reaches SETTLED on anything but a captured report", () => {
    const reachesSettled = TRANSITIONS.filter((t) => t.from === "AWAITING_PAYMENT" && t.to === "SETTLED");
    expect(reachesSettled.map((t) => t.reasonCode)).toEqual(["PAYMENT_CAPTURED"]);
  });
});

// ===========================================================================
// Invariant 2 — divergence is recorded before it is corrected
// ===========================================================================

describe("INVARIANT: a rail divergence is recorded before the correction, and the hold is released exactly once (PRD §12, §17 rows 6-7, §21.11)", () => {
  it("a captured-amount mismatch is its own reason code — RAIL_STATE_DIVERGENCE, not a plain PAYMENT_FAILED", () => {
    const transition = resolveRailReportTransition("CONTRADICTS_LOCAL");
    expect(transition.reasonCode).toBe("RAIL_STATE_DIVERGENCE");
    expect(transition.to).toBe("PAYMENT_FAILED");
    // The frozen guard prose says so out loud.
    expect(transition.guard).toMatch(/before the correction/i);
  });

  it("in a Tier 2 divergence timeline, RAIL_STATE_DIVERGENCE always precedes the HOLD_RELEASED that unwinds its hold", () => {
    const chain = buildChain([
      ...PRE_PAYMENT_PREFIX,
      eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
      eventOf(resolvePaymentInitiationTransition(false), { orderId: "order-1" }),
      eventOf(resolveRailReportTransition("CONTRADICTS_LOCAL"), {
        orderId: "order-1",
        expectedAmountMinor: 230_000,
        capturedAmountMinor: 999_000,
      }),
      eventOf(resolveHoldReleaseTransition("PAYMENT_FAILED", 2), { holdId: "hold-1", amountMinor: 20_000 }),
    ]);

    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: chain.length });

    const codes = chain.map((e) => e.reasonCode);
    expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeLessThan(codes.indexOf("HOLD_RELEASED"));
  });

  it("the same ordering holds for a plain FAILED report on a Tier 2 offer", () => {
    const chain = buildChain([
      ...PRE_PAYMENT_PREFIX,
      eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
      eventOf(resolvePaymentInitiationTransition(false), { orderId: "order-1" }),
      eventOf(resolveRailReportTransition("FAILED"), { orderId: "order-1" }),
      eventOf(resolveHoldReleaseTransition("PAYMENT_FAILED", 2), { holdId: "hold-1", amountMinor: 20_000 }),
    ]);

    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: chain.length });
    const codes = chain.map((e) => e.reasonCode);
    expect(codes.indexOf("PAYMENT_FAILED")).toBeLessThan(codes.indexOf("HOLD_RELEASED"));
  });

  it("only a Tier 2 offer has a hold to release — the release resolver refuses Tier 1, so a Tier 1 failure emits no HOLD_RELEASED", () => {
    expect(() => resolveHoldReleaseTransition("PAYMENT_FAILED", 1)).toThrow(/tier 2/i);
    expect(() => resolveHoldCommittedTransition(1)).toThrow(/tier 2/i);
  });

  it("there is exactly one HOLD_RELEASED row reachable from PAYMENT_FAILED — a second release has nowhere to land", () => {
    const releases = TRANSITIONS.filter((t) => t.from === "PAYMENT_FAILED" && t.reasonCode === "HOLD_RELEASED");
    expect(releases).toHaveLength(1);
    expect(releases[0]!.to).toBe("PAYMENT_FAILED");
  });
});

// ===========================================================================
// Invariant 3 — the autonomous-payment flag is a real closed boundary
// ===========================================================================

describe("INVARIANT: autonomous payment cannot occur when disabled — the flag is a closed boundary, not an assumption (PRD §9.2, §9.3, §21.13)", () => {
  it("autonomousPaymentExecution === true fails closed with its own reason code and never advances the session", () => {
    const transition = resolvePaymentInitiationTransition(true);
    expect(transition.reasonCode).toBe("AUTONOMOUS_PAYMENT_NOT_AUTHORIZED");
    // A self-loop on ACCEPTED: the session does not move on to AWAITING_PAYMENT
    // or anywhere a payment could proceed from.
    expect(transition.from).toBe("ACCEPTED");
    expect(transition.to).toBe("ACCEPTED");
  });

  it("only autonomousPaymentExecution === false reaches the order-creation path", () => {
    const transition = resolvePaymentInitiationTransition(false);
    expect(transition.reasonCode).toBe("ORDER_CREATED");
    expect(transition.to).toBe("AWAITING_PAYMENT");

    // Structurally: the one row that carries a session out of ACCEPTED toward
    // payment is guarded on the flag being false. Flip it and there is no row.
    const forwardFromAccepted = TRANSITIONS.filter((t) => t.from === "ACCEPTED" && t.to === "AWAITING_PAYMENT");
    expect(forwardFromAccepted.map((t) => t.reasonCode)).toEqual(["ORDER_CREATED"]);
    expect(forwardFromAccepted[0]!.guard).toMatch(/=== false/);
  });

  it("the refusal is a real transition with a real code — never null, never a silent no-op", () => {
    // Both branches return an actual TRANSITIONS row (reference equality), so
    // there is no code path here that quietly returns undefined and lets a
    // caller proceed as if the gate passed.
    for (const flag of [true, false]) {
      const transition = resolvePaymentInitiationTransition(flag);
      expect(TRANSITIONS).toContain(transition);
      expect(REASON_CODES).toContain(transition.reasonCode);
    }
  });

  it("the refusal event hash-chains like any other — it is audited, not swallowed", () => {
    const chain = buildChain([
      ...PRE_PAYMENT_PREFIX,
      eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
      eventOf(resolvePaymentInitiationTransition(true), { reason: "not implemented in the MVP" }),
    ]);
    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: chain.length });
    expect(chain.at(-1)!.reasonCode).toBe("AUTONOMOUS_PAYMENT_NOT_AUTHORIZED");
  });
});

// ===========================================================================
// Invariant 4 — every transition produces one verifiable event
// ===========================================================================

describe("INVARIANT: every payment-path transition produces exactly one event and the chain verifies (PRD §13, §21.14)", () => {
  /** The three ways a payment-path negotiation can end, each derived entirely from resolver calls after the shared prefix. */
  const timelines: ReadonlyArray<{ name: string; tail: readonly EventContent[]; expectTailCodes: readonly ReasonCode[] }> = [
    {
      name: "capture — order created, rail captures, Tier 2 hold committed",
      tail: [
        eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
        eventOf(resolvePaymentInitiationTransition(false), { orderId: "order-1" }),
        eventOf(resolveRailReportTransition("CAPTURED"), { orderId: "order-1" }),
        eventOf(resolveHoldCommittedTransition(2), { holdId: "hold-1", amountMinor: 20_000 }),
      ],
      expectTailCodes: ["OFFER_ACCEPTED", "ORDER_CREATED", "PAYMENT_CAPTURED", "HOLD_COMMITTED"],
    },
    {
      name: "failure — order created, rail fails, Tier 2 hold released",
      tail: [
        eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
        eventOf(resolvePaymentInitiationTransition(false), { orderId: "order-1" }),
        eventOf(resolveRailReportTransition("FAILED"), { orderId: "order-1" }),
        eventOf(resolveHoldReleaseTransition("PAYMENT_FAILED", 2), { holdId: "hold-1", amountMinor: 20_000 }),
      ],
      expectTailCodes: ["OFFER_ACCEPTED", "ORDER_CREATED", "PAYMENT_FAILED", "HOLD_RELEASED"],
    },
    {
      name: "divergence — order created, rail captures a wrong amount, Tier 2 hold released",
      tail: [
        eventOf(resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true })),
        eventOf(resolvePaymentInitiationTransition(false), { orderId: "order-1" }),
        eventOf(resolveRailReportTransition("CONTRADICTS_LOCAL"), {
          orderId: "order-1",
          expectedAmountMinor: 230_000,
          capturedAmountMinor: 999_000,
        }),
        eventOf(resolveHoldReleaseTransition("PAYMENT_FAILED", 2), { holdId: "hold-1", amountMinor: 20_000 }),
      ],
      expectTailCodes: ["OFFER_ACCEPTED", "ORDER_CREATED", "RAIL_STATE_DIVERGENCE", "HOLD_RELEASED"],
    },
  ];

  it.each(timelines)("$name: the whole chain verifies from genesis, one event per transition", ({ tail, expectTailCodes }) => {
    const chain = buildChain([...PRE_PAYMENT_PREFIX, ...tail]);

    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: PRE_PAYMENT_PREFIX.length + tail.length });
    expect(chain.map((e) => e.sequence)).toEqual(chain.map((_, i) => i));
    expect(chain[0]!.prevHash).toBeNull();
    for (const event of chain) {
      expect(REASON_CODES).toContain(event.reasonCode);
      expect(event.eventHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(chain.slice(PRE_PAYMENT_PREFIX.length).map((e) => e.reasonCode)).toEqual(expectTailCodes);
  });

  it.each(timelines)("$name: tampering with the rail-report event breaks verification exactly there", ({ tail }) => {
    const chain = buildChain([...PRE_PAYMENT_PREFIX, ...tail]);
    // The rail report is the third-from-last event in every timeline
    // (…accept, order-created, RAIL REPORT, hold unwind).
    const railIndex = chain.length - 2;
    const tampered = chain.map((event, index) =>
      index === railIndex ? { ...event, payload: { orderId: "tampered" } } : event,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("HASH_MISMATCH");
      expect(result.brokenAtIndex).toBe(railIndex);
    }
    // The untouched original still verifies clean.
    expect(verifyChain(chain).valid).toBe(true);
  });

  it("every payment-and-rail reason code is reachable through a resolver, not merely present in the enum", () => {
    const reachable = new Set<ReasonCode>([
      resolvePaymentInitiationTransition(true).reasonCode,
      resolvePaymentInitiationTransition(false).reasonCode,
      resolveRailReportTransition("CAPTURED").reasonCode,
      resolveRailReportTransition("FAILED").reasonCode,
      resolveRailReportTransition("CONTRADICTS_LOCAL").reasonCode,
      resolveHoldCommittedTransition(2).reasonCode,
      resolveHoldReleaseTransition("PAYMENT_FAILED", 2).reasonCode,
    ]);

    const paymentAndRailCodes: readonly ReasonCode[] = [
      "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED",
      "ORDER_CREATED",
      "PAYMENT_CAPTURED",
      "PAYMENT_FAILED",
      "RAIL_STATE_DIVERGENCE",
      "HOLD_COMMITTED",
      "HOLD_RELEASED",
    ];
    for (const code of paymentAndRailCodes) {
      expect(reachable).toContain(code);
    }
  });
});
