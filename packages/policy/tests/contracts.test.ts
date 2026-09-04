import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_HOLD_STATES,
  CANDIDATE_MOVE_TYPES,
  COMMITMENT_TYPES,
  MAX_CANDIDATES,
  NEGOTIATION_STATES,
  REASON_CODES,
  REASON_CODE_COUNT,
  TERMINAL_STATES,
  TRANSITIONS,
  isTerminal,
  minorUnitsSchema,
  negotiationIntentSchema,
} from "../contracts";

/**
 * These tests exist to make the frozen contracts fail loudly if someone edits
 * them casually while other agents are building against them. They assert the
 * shape of the agreement, not the behaviour of any implementation.
 */

describe("ReasonCode enum is closed at 28", () => {
  it("has exactly the frozen number of members", () => {
    expect(REASON_CODES).toHaveLength(REASON_CODE_COUNT);
  });

  it("contains no duplicates", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it("matches the exact list reviewed against the state machine (PRD §14)", () => {
    expect([...REASON_CODES]).toEqual([
      "SESSION_FLAGGED_AT_RISK",
      "NOT_AT_RISK",
      "NEGOTIATION_DISABLED",
      "SKU_NOT_NEGOTIABLE",
      "NEGOTIATION_OPENED",
      "CANDIDATES_EVALUATED",
      "NO_FEASIBLE_BASKET",
      "FLOOR_BREACH",
      "TIER1_OFFERED",
      "TIER1_REFUSED_BY_BUYER",
      "DILUTION_WITHIN_CAPS",
      "DILUTION_EXCEEDS_PER_DEAL_CAP",
      "CAMPAIGN_BUDGET_EXHAUSTED",
      "ROUND_LIMIT_REACHED",
      "OFFER_ACCEPTED",
      "OFFER_EXPIRED",
      "OFFER_ALREADY_CONSUMED",
      "BASKET_MISMATCH",
      "BUYER_DECLINED",
      "WALK_AWAY",
      "HOLD_RESERVED",
      "HOLD_RELEASED",
      "HOLD_COMMITTED",
      "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED",
      "ORDER_CREATED",
      "PAYMENT_CAPTURED",
      "PAYMENT_FAILED",
      "RAIL_STATE_DIVERGENCE",
    ]);
  });

  it("does not carry OFFER_MINTED, which the tier codes already encode", () => {
    expect(REASON_CODES).not.toContain("OFFER_MINTED");
  });
});

describe("state machine", () => {
  it("has the twelve frozen states, six of them terminal", () => {
    expect(NEGOTIATION_STATES).toHaveLength(12);
    expect(TERMINAL_STATES).toHaveLength(6);
  });

  it("agrees with isTerminal", () => {
    for (const state of NEGOTIATION_STATES) {
      const expected = (TERMINAL_STATES as readonly string[]).includes(state);
      expect(isTerminal(state)).toBe(expected);
    }
  });

  it("gives every transition exactly one reason code from the closed enum", () => {
    for (const transition of TRANSITIONS) {
      expect(REASON_CODES).toContain(transition.reasonCode);
    }
  });

  it("never transitions out of a terminal state except to itself", () => {
    for (const transition of TRANSITIONS) {
      if (transition.from === "*") continue;
      if (!isTerminal(transition.from)) continue;
      expect(transition.to).toBe(transition.from);
    }
  });

  it("reaches every reason code except the defensive assertion", () => {
    const reached = new Set(TRANSITIONS.map((t) => t.reasonCode));
    const unreached = REASON_CODES.filter((code) => !reached.has(code));
    // FLOOR_BREACH is reachable only via the defensive assertion, which is in
    // the table; every other code must be produced by a real transition.
    expect(unreached).toEqual([]);
  });

  it("keeps the defensive floor assertion, and halts when it fires", () => {
    const floorBreach = TRANSITIONS.find((t) => t.reasonCode === "FLOOR_BREACH");
    expect(floorBreach).toBeDefined();
    expect(floorBreach?.from).toBe("*");
    expect(floorBreach?.to).toBe("HALTED");
  });
});

describe("NegotiationIntent carries no monetary field", () => {
  it("accepts a candidate reference and a frame", () => {
    const parsed = negotiationIntentSchema.parse({
      candidateId: "cand_7",
      messageFrame: "BUNDLE_VALUE",
    });
    expect(parsed.candidateId).toBe("cand_7");
  });

  it("rejects any attempt to smuggle an amount through it", () => {
    const result = negotiationIntentSchema.safeParse({
      candidateId: "cand_7",
      messageFrame: "BUNDLE_VALUE",
      totalMinor: 265000,
    });
    expect(result.success).toBe(false);
  });

  it("permits only WALK_AWAY as a terminal action", () => {
    expect(
      negotiationIntentSchema.safeParse({
        candidateId: "cand_7",
        messageFrame: "FINAL_POSITION",
        terminalAction: "ACCEPT_ANY_PRICE",
      }).success,
    ).toBe(false);
  });
});

describe("money is always integer minor units", () => {
  it("accepts paise", () => {
    expect(minorUnitsSchema.parse(302000)).toBe(302000);
  });

  it("rejects a float, so rupees can never leak into the engine", () => {
    expect(minorUnitsSchema.safeParse(3020.5).success).toBe(false);
  });

  it("rejects a negative price", () => {
    expect(minorUnitsSchema.safeParse(-1).success).toBe(false);
  });
});

describe("closed sets used by generation and budgeting", () => {
  it("caps the candidate search at twelve", () => {
    expect(MAX_CANDIDATES).toBe(12);
  });

  it("has exactly the five frozen move types", () => {
    expect([...CANDIDATE_MOVE_TYPES]).toEqual([
      "PRICE_CONCESSION",
      "ADD_SKU",
      "ADD_SLOW_MOVING_SKU",
      "INCREASE_QUANTITY",
      "COMMITMENT_SWAP",
    ]);
  });

  it("has exactly the three allowed commitments", () => {
    expect(COMMITMENT_TYPES).toHaveLength(3);
  });

  it("moves budget through reserve, release, commit", () => {
    expect([...CAMPAIGN_HOLD_STATES]).toEqual(["RESERVED", "RELEASED", "COMMITTED"]);
  });
});
