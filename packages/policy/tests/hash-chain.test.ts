import { describe, expect, it } from "vitest";

import { computeEventHash, verifyChain, type ChainEvent, type HashableAuditEvent } from "../ledger";

/**
 * TICKET-401 — append-only ledger writer with hash chaining (PRD §13,
 * CONTRACTS.md §7).
 *
 * Pure, instant, no database (CONTRACTS.md §8: "packages/policy is pure and
 * needs no seam — call it directly"). The real-Postgres half of this ticket
 * — appending real rows and verifying a chain fetched from the database, plus
 * the tamper test against a real fetched chain — lives in
 * `packages/database/tests/audit-events.test.ts`.
 *
 * These assert external behaviour only (CONTRACTS.md §8): does the chain
 * verify, and when it doesn't, what broke and where — never "was
 * `canonicalize` called with these arguments."
 */

/** One event's hashable content, without `prevHash` — set by `buildChain` below. */
type EventContent = Omit<HashableAuditEvent, "sequence" | "prevHash">;

/**
 * Builds a valid, hash-linked chain from a list of event contents, exactly as
 * `packages/database/repositories/audit-events.ts`'s `appendAuditEvent` would
 * build it one row at a time: sequence 0, 1, 2, ...; each event's `prevHash`
 * is its predecessor's `eventHash` (`null` for genesis); each `eventHash` is
 * `computeEventHash` over the event's own fields.
 */
function buildChain(contents: readonly EventContent[]): ChainEvent[] {
  const chain: ChainEvent[] = [];
  let prevHash: string | null = null;

  for (let sequence = 0; sequence < contents.length; sequence++) {
    const content = contents[sequence]!;
    const withoutHash: HashableAuditEvent = { ...content, sequence, prevHash };
    const eventHash = computeEventHash(withoutHash);
    chain.push({ ...withoutHash, eventHash });
    prevHash = eventHash;
  }

  return chain;
}

/** A plausible multi-step negotiation, reusing the codes from PRD §18.2's worked example. */
const NEGOTIATION_SESSION_ID = "11111111-1111-1111-1111-111111111111";

const A_FULL_NEGOTIATION: readonly EventContent[] = [
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "ELIGIBILITY_RULES_MATCH",
    fromState: "IDLE",
    toState: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
    payload: { cartAgeSeconds: 900 },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "NEGOTIATION_REQUESTED",
    fromState: "AT_RISK",
    toState: "OPEN",
    reasonCode: "NEGOTIATION_OPENED",
    payload: {},
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "CANDIDATES_GENERATED",
    fromState: "OPEN",
    toState: "OPEN",
    reasonCode: "CANDIDATES_EVALUATED",
    payload: { evaluated: 12, feasible: 9, tier1: 4 },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "TIER1_OFFERED",
    payload: { candidateId: "cand-bundle-1", totalMinor: 302_000 },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "TIER1_REFUSED_BY_BUYER",
    payload: { candidateId: "cand-bundle-1" },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "DILUTION_WITHIN_CAPS",
    payload: { candidateId: "cand-original-cart", shortfallMinor: 20_000 },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
    payload: { holdId: "hold-1", amountMinor: 20_000 },
  },
  {
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "BUYER_ACCEPTS",
    fromState: "OFFER_PENDING",
    toState: "ACCEPTED",
    reasonCode: "OFFER_ACCEPTED",
    payload: { candidateId: "cand-original-cart" },
  },
];

describe("computeEventHash — deterministic content hashing", () => {
  const baseEvent: HashableAuditEvent = {
    sequence: 0,
    sessionId: NEGOTIATION_SESSION_ID,
    eventType: "ELIGIBILITY_RULES_MATCH",
    fromState: "IDLE",
    toState: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
    payload: { cartAgeSeconds: 900 },
    prevHash: null,
  };

  it("is deterministic: the same event content always produces the same hash", () => {
    const first = computeEventHash(baseEvent);
    const second = computeEventHash({ ...baseEvent });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  it("is insensitive to payload key order — the same content built in a different key order hashes identically", () => {
    const insertedZThenA: Record<string, unknown> = {};
    insertedZThenA.zzz = "same";
    insertedZThenA.cartAgeSeconds = 900;

    const insertedAThenZ: Record<string, unknown> = {};
    insertedAThenZ.cartAgeSeconds = 900;
    insertedAThenZ.zzz = "same";

    const first: HashableAuditEvent = { ...baseEvent, payload: insertedZThenA };
    const second: HashableAuditEvent = { ...baseEvent, payload: insertedAThenZ };

    expect(computeEventHash(first)).toBe(computeEventHash(second));
  });

  it.each<[string, Partial<HashableAuditEvent>]>([
    ["sequence", { sequence: 1 }],
    ["sessionId", { sessionId: "22222222-2222-2222-2222-222222222222" }],
    ["eventType", { eventType: "NEGOTIATION_REQUESTED" }],
    ["fromState", { fromState: "OPEN" }],
    ["toState", { toState: "WALKED_AWAY" }],
    ["reasonCode", { reasonCode: "NOT_AT_RISK" }],
    ["payload", { payload: { cartAgeSeconds: 901 } }],
    ["prevHash", { prevHash: "a".repeat(64) }],
  ])("changes when %s changes, holding everything else fixed", (_field, change) => {
    const changed: HashableAuditEvent = { ...baseEvent, ...change };
    expect(computeEventHash(changed)).not.toBe(computeEventHash(baseEvent));
  });
});

describe("verifyChain — over a full negotiation", () => {
  it("validates a hand-constructed valid chain from genesis to acceptance", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const result = verifyChain(chain);
    expect(result).toEqual({ valid: true, eventCount: A_FULL_NEGOTIATION.length });
  });

  it("treats an empty chain as vacuously valid", () => {
    expect(verifyChain([])).toEqual({ valid: true, eventCount: 0 });
  });

  it("validates a single-event (genesis-only) chain", () => {
    const chain = buildChain(A_FULL_NEGOTIATION.slice(0, 1));
    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: 1 });
  });
});

describe("verifyChain — rejects a hand-constructed broken chain", () => {
  it("rejects tampered content: reasonCode changed on a stored event without recomputing its hash", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const tamperedIndex = 5; // the DILUTION_WITHIN_CAPS event
    const tampered = chain.map((event, index) =>
      index === tamperedIndex ? { ...event, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" as const } : event,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("HASH_MISMATCH");
      expect(result.brokenAtIndex).toBe(tamperedIndex);
      expect(result.brokenAtSequence).toBe(tamperedIndex);
    }

    // The untampered original still verifies clean.
    expect(verifyChain(chain)).toEqual({ valid: true, eventCount: chain.length });
  });

  it("rejects tampered content: payload changed on a stored event without recomputing its hash", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const tamperedIndex = 3; // the TIER1_OFFERED event
    const tampered = chain.map((event, index) =>
      index === tamperedIndex ? { ...event, payload: { candidateId: "cand-bundle-1", totalMinor: 1 } } : event,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("HASH_MISMATCH");
      expect(result.brokenAtIndex).toBe(tamperedIndex);
    }
  });

  it("rejects broken linkage: an event's prevHash no longer matches its predecessor's eventHash", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const brokenIndex = 4;
    const tampered = chain.map((event, index) =>
      index === brokenIndex ? { ...event, prevHash: "f".repeat(64) } : event,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("BROKEN_LINKAGE");
      expect(result.brokenAtIndex).toBe(brokenIndex);
    }
  });

  it("rejects a genesis event carrying a non-null prevHash", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const tampered = chain.map((event, index) =>
      index === 0 ? { ...event, prevHash: "0".repeat(64) } : event,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("BROKEN_LINKAGE");
      expect(result.brokenAtIndex).toBe(0);
    }
  });

  it("rejects a sequence gap", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    const tampered = chain.map((event, index) => (index === 6 ? { ...event, sequence: 60 } : event));

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("SEQUENCE_GAP");
      expect(result.brokenAtIndex).toBe(6);
    }
  });

  it("rejects a duplicated sequence number", () => {
    const chain = buildChain(A_FULL_NEGOTIATION);
    // Duplicate event 2's sequence onto event 3 as well (shifts every hash
    // after it out of alignment too, but the first break is what's reported).
    const tampered = chain.map((event, index) => (index === 3 ? { ...event, sequence: 2 } : event));

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("SEQUENCE_GAP");
      expect(result.brokenAtIndex).toBe(3);
    }
  });
});
