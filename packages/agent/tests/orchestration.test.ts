import { describe, expect, it } from "vitest";
import type { Candidate, CampaignBudgetReservationOutcome, NegotiationIntent } from "@repo/policy";
import type { NegotiationModel, NegotiationRoundInput } from "../model";
import {
  INITIAL_ROUND_STATE,
  applyOfferDeclined,
  runNegotiationRound,
  selectExposedCandidates,
  type RoundState,
  type RunNegotiationRoundInput,
} from "../orchestration";
import { fakeCandidate } from "./support/fake-candidate";

/**
 * TICKET-202 — merchant agent orchestration loop.
 *
 * Covers this ticket's three required tests directly:
 *  - "Round 1 exposes only Tier 1 candidates to the model" / Tier 2 never
 *    reachable in round 1.
 *  - "A Tier 1 refusal sets tier1_refused and unlocks Tier 2 for later
 *    rounds" / refusal unlocks correctly.
 *  - "WALK_AWAY terminates cleanly with its code" / walk-away terminates.
 *
 * Asserts external behaviour (CONTRACTS.md §8): what the model is shown and
 * what `runNegotiationRound` returns, never internal call structure.
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const POLICY_VERSION = 1;
const OFFER_TTL_SECONDS = 600;
const NOW = new Date("2026-01-01T00:00:00.000Z");

const tier1Candidate = fakeCandidate({
  candidateId: "cand_tier1",
  tier: 1,
  contributionDeltaMinor: 0,
  requiredCampaignSpendMinor: 0,
  feasible: true,
  infeasibleReason: null,
});

const tier2Candidate = fakeCandidate({
  candidateId: "cand_tier2",
  tier: 2,
  contributionDeltaMinor: -20_000,
  requiredCampaignSpendMinor: 20_000,
  feasible: true,
  infeasibleReason: null,
});

const RESERVED: CampaignBudgetReservationOutcome = {
  reserved: true,
  offerId: "22222222-2222-4222-8222-222222222222",
  amountMinor: tier2Candidate.requiredCampaignSpendMinor,
};

const CANDIDATES: readonly Candidate[] = [tier1Candidate, tier2Candidate];

/**
 * A `NegotiationModel` that records the `candidates` it was actually shown
 * (proving exposure, not just the returned intent) and returns whatever
 * fixed intent it was configured with regardless of input — same
 * determinism style as `ScriptedNegotiationModel`, but capturing its input
 * for assertions this ticket's tests need that the scripted double alone
 * doesn't expose.
 */
class RecordingModel implements NegotiationModel {
  public receivedInputs: NegotiationRoundInput[] = [];
  constructor(private readonly intent: NegotiationIntent) {}

  nextIntent(input: NegotiationRoundInput): NegotiationIntent {
    this.receivedInputs.push(input);
    return this.intent;
  }
}

function baseRoundInput(
  overrides: Partial<Omit<RunNegotiationRoundInput, "model">> & Pick<RunNegotiationRoundInput, "model">,
): RunNegotiationRoundInput {
  return {
    sessionId: SESSION_ID,
    state: INITIAL_ROUND_STATE,
    policyVersion: POLICY_VERSION,
    candidatesInRound: CANDIDATES,
    conversation: [],
    now: NOW,
    offerTtlSeconds: OFFER_TTL_SECONDS,
    signingSecret: "test-signing-secret",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectExposedCandidates — the exposure rule in isolation
// ---------------------------------------------------------------------------

describe("selectExposedCandidates — Tier 2 never reachable before a refusal", () => {
  it("round 1 (tier1Refused: false) exposes only the Tier 1 candidate", () => {
    const exposed = selectExposedCandidates(CANDIDATES, false);
    expect(exposed.map((c) => c.candidateId)).toEqual(["cand_tier1"]);
  });

  it("once tier1Refused is true, both Tier 1 and Tier 2 candidates are exposed", () => {
    const exposed = selectExposedCandidates(CANDIDATES, true);
    expect(exposed.map((c) => c.candidateId).sort()).toEqual(["cand_tier1", "cand_tier2"]);
  });

  it("an infeasible Tier 1 candidate is still excluded even in round 1", () => {
    const infeasibleTier1 = fakeCandidate({
      candidateId: "cand_tier1_infeasible",
      tier: 1,
      feasible: false,
      infeasibleReason: "FLOOR_BREACH",
    });
    const exposed = selectExposedCandidates([infeasibleTier1], false);
    expect(exposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion: round 1 exposes only Tier 1 candidates to the model
// ---------------------------------------------------------------------------

describe("runNegotiationRound — round 1 exposes only Tier 1 candidates to the model", () => {
  it("the model only ever sees the Tier 1 candidate on round 1, never the Tier 2 one", async () => {
    const model = new RecordingModel({ candidateId: "cand_tier1", messageFrame: "BUNDLE_VALUE" });

    await runNegotiationRound(baseRoundInput({ model }));

    expect(model.receivedInputs).toHaveLength(1);
    const shown = model.receivedInputs[0]!.candidates;
    expect(shown.map((c) => c.candidateId)).toEqual(["cand_tier1"]);
  });

  it("even if a model ignores exposure and names the Tier 2 candidate directly, minting refuses it (fail closed)", async () => {
    const model = new RecordingModel({ candidateId: "cand_tier2", messageFrame: "COMMITMENT_TRADE" });

    await expect(
      runNegotiationRound(baseRoundInput({ model, campaignBudgetReservation: RESERVED })),
    ).rejects.toThrow(/Tier 2.*tier1Refused is false/i);
  });

  it("mints the Tier 1 candidate and advances the round on a normal round-1 intent", async () => {
    const model = new RecordingModel({ candidateId: "cand_tier1", messageFrame: "BUNDLE_VALUE" });

    const result = await runNegotiationRound(baseRoundInput({ model }));

    if (result.status !== "OFFER_MINTED") throw new Error(`expected OFFER_MINTED, got ${result.status}`);
    expect(result.offer.candidateId).toBe("cand_tier1");
    expect(result.offer.tier).toBe(1);
    expect(result.nextState).toEqual({ roundIndex: 2, tier1Refused: false });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion: a Tier 1 refusal sets tier1_refused and unlocks Tier 2
// ---------------------------------------------------------------------------

describe("applyOfferDeclined / runNegotiationRound — a Tier 1 refusal unlocks Tier 2 for later rounds", () => {
  it("declining a Tier 1 offer sets tier1Refused", () => {
    const afterRound1: RoundState = { roundIndex: 2, tier1Refused: false };
    const next = applyOfferDeclined(afterRound1, { tier: 1 });
    expect(next).toEqual({ roundIndex: 2, tier1Refused: true });
  });

  it("declining a Tier 2 offer never sets tier1Refused (RA-2: only a Tier 1 refusal counts)", () => {
    const state: RoundState = { roundIndex: 3, tier1Refused: false };
    const next = applyOfferDeclined(state, { tier: 2 });
    expect(next).toEqual(state);
  });

  it("once tier1Refused is already true, declining another Tier 1 offer is a no-op", () => {
    const state: RoundState = { roundIndex: 4, tier1Refused: true };
    const next = applyOfferDeclined(state, { tier: 1 });
    expect(next).toEqual(state);
  });

  it("end to end: round 1 mints Tier 1, a decline unlocks round 2 to expose Tier 2 to the model", async () => {
    // Round 1: only the Tier 1 candidate is offered and minted.
    const round1Model = new RecordingModel({ candidateId: "cand_tier1", messageFrame: "BUNDLE_VALUE" });
    const round1 = await runNegotiationRound(baseRoundInput({ model: round1Model }));
    if (round1.status !== "OFFER_MINTED") throw new Error("expected round 1 to mint");
    expect(round1.nextState.tier1Refused).toBe(false);

    // The buyer declines that Tier 1 offer.
    const round2State = applyOfferDeclined(round1.nextState, round1.offer);
    expect(round2State).toEqual({ roundIndex: 2, tier1Refused: true });

    // Round 2: a freshly generated candidate batch for this round (mintOffer
    // asserts every candidate belongs to the requested roundIndex) — same
    // ids and tiers, just re-stamped for round 2.
    const round2Candidates: readonly Candidate[] = CANDIDATES.map((c) => ({ ...c, roundIndex: 2 }));
    const round2Model = new RecordingModel({ candidateId: "cand_tier2", messageFrame: "COMMITMENT_TRADE" });
    const round2 = await runNegotiationRound(
      baseRoundInput({
        state: round2State,
        model: round2Model,
        candidatesInRound: round2Candidates,
        campaignBudgetReservation: RESERVED,
      }),
    );

    expect(round2Model.receivedInputs[0]!.candidates.map((c) => c.candidateId).sort()).toEqual([
      "cand_tier1",
      "cand_tier2",
    ]);
    if (round2.status !== "OFFER_MINTED") throw new Error("expected round 2 to mint");
    expect(round2.offer.tier).toBe(2);
    expect(round2.nextState).toEqual({ roundIndex: 3, tier1Refused: true });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion: WALK_AWAY terminates cleanly with its code
// ---------------------------------------------------------------------------

describe("runNegotiationRound — WALK_AWAY terminates cleanly with its code", () => {
  it("returns status WALKED_AWAY with reasonCode WALK_AWAY when the model's intent carries the terminal action", async () => {
    const model = new RecordingModel({
      candidateId: "cand_tier1",
      messageFrame: "FINAL_POSITION",
      terminalAction: "WALK_AWAY",
    });

    const result = await runNegotiationRound(baseRoundInput({ model }));

    expect(result.status).toBe("WALKED_AWAY");
    if (result.status !== "WALKED_AWAY") throw new Error("expected WALKED_AWAY");
    expect(result.reasonCode).toBe("WALK_AWAY");
  });

  it("does not advance the round state past a walk-away", async () => {
    const model = new RecordingModel({
      candidateId: "cand_tier1",
      messageFrame: "FINAL_POSITION",
      terminalAction: "WALK_AWAY",
    });
    const state: RoundState = { roundIndex: 5, tier1Refused: true };

    const result = await runNegotiationRound(baseRoundInput({ state, model }));

    expect(result.nextState).toEqual(state);
  });

  it("never reaches mintOffer on a walk-away — an out-of-set candidateId does not throw", async () => {
    // A candidateId absent from candidatesInRound would make mintOffer throw
    // ("not in this round's engine-authored candidate set"). No throw here
    // proves mintOffer was never called once terminalAction is WALK_AWAY.
    const model = new RecordingModel({
      candidateId: "cand_does_not_exist",
      messageFrame: "FINAL_POSITION",
      terminalAction: "WALK_AWAY",
    });

    await expect(runNegotiationRound(baseRoundInput({ model }))).resolves.toMatchObject({
      status: "WALKED_AWAY",
      reasonCode: "WALK_AWAY",
    });
  });
});

// ---------------------------------------------------------------------------
// Other terminal condition: a coded mint rejection is also terminal
// ---------------------------------------------------------------------------

describe("runNegotiationRound — a coded mint rejection is terminal too, distinct from WALK_AWAY", () => {
  it("surfaces MINT_REJECTED with the candidate's own infeasibleReason and does not advance the round", async () => {
    const infeasibleTier2 = fakeCandidate({
      candidateId: "cand_tier2_infeasible",
      tier: 2,
      requiredCampaignSpendMinor: 999_999,
      feasible: false,
      infeasibleReason: "DILUTION_EXCEEDS_PER_DEAL_CAP",
    });
    const model = new RecordingModel({ candidateId: "cand_tier2_infeasible", messageFrame: "COMMITMENT_TRADE" });
    const state: RoundState = { roundIndex: 1, tier1Refused: true };

    const result = await runNegotiationRound(
      baseRoundInput({ state, model, candidatesInRound: [tier1Candidate, infeasibleTier2] }),
    );

    expect(result.status).toBe("MINT_REJECTED");
    if (result.status !== "MINT_REJECTED") throw new Error("expected MINT_REJECTED");
    expect(result.reasonCode).toBe("DILUTION_EXCEEDS_PER_DEAL_CAP");
    expect(result.nextState).toEqual(state);
  });
});
