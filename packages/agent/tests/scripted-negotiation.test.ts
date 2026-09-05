import { describe, expect, it } from "vitest";
import type { NegotiationIntent } from "@repo/policy";
import { ScriptedNegotiationModel, type NegotiationModel, type NegotiationRoundInput } from "../model";
import { fakeCandidate } from "./support/fake-candidate";

/**
 * TICKET-201 acceptance criterion: "A scripted implementation satisfies the
 * interface with the same power as a real model" / "Scripted model drives a
 * full negotiation."
 *
 * Asserts external behaviour (CONTRACTS.md §8): what comes back on each
 * round, not how the class stores its state internally.
 */

function round(
  roundIndex: number,
  candidates: NegotiationRoundInput["candidates"],
  buyerSaid: string,
): NegotiationRoundInput {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    roundIndex,
    candidates,
    conversation: [{ role: "buyer", content: buyerSaid }],
  };
}

describe("ScriptedNegotiationModel drives a full negotiation deterministically", () => {
  const tier1Candidate = fakeCandidate({ candidateId: "cand_tier1_bundle" });
  const tier2Candidate = fakeCandidate({
    candidateId: "cand_tier2_rescue",
    tier: 2,
    requiredCampaignSpendMinor: 20000,
  });

  const script: NegotiationIntent[] = [
    { candidateId: "cand_tier1_bundle", messageFrame: "BUNDLE_VALUE" },
    { candidateId: "cand_tier2_rescue", messageFrame: "COMMITMENT_TRADE" },
    { candidateId: "cand_tier2_rescue", messageFrame: "FINAL_POSITION", terminalAction: "WALK_AWAY" },
  ];

  it("produces the exact scripted sequence, in order, across a full multi-round negotiation", () => {
    const model = new ScriptedNegotiationModel(script);

    const r1 = model.nextIntent(round(1, [tier1Candidate], "I want this cart, cheaper."));
    const r2 = model.nextIntent(
      round(2, [tier1Candidate, tier2Candidate], "No, I won't add anything to the cart."),
    );
    const r3 = model.nextIntent(
      round(3, [tier2Candidate], "₹2,200 or I'm leaving."),
    );

    expect([r1, r2, r3]).toEqual(script);
  });

  it("a normal round produces candidateId + messageFrame with no terminal action", () => {
    const model = new ScriptedNegotiationModel(script);
    const first = model.nextIntent(round(1, [tier1Candidate], "anything"));

    expect(first).toEqual({ candidateId: "cand_tier1_bundle", messageFrame: "BUNDLE_VALUE" });
    expect(first.terminalAction).toBeUndefined();
  });

  it("the final scripted round terminates the negotiation with WALK_AWAY", () => {
    const model = new ScriptedNegotiationModel(script);
    model.nextIntent(round(1, [tier1Candidate], "anything"));
    model.nextIntent(round(2, [tier1Candidate, tier2Candidate], "anything"));
    const final = model.nextIntent(round(3, [tier2Candidate], "anything"));

    expect(final.terminalAction).toBe("WALK_AWAY");
    expect(model.isExhausted).toBe(true);
    expect(model.callCount).toBe(3);
  });

  it("throws rather than silently repeating or inventing an intent once exhausted", () => {
    const model = new ScriptedNegotiationModel([script[0]!]);
    model.nextIntent(round(1, [tier1Candidate], "anything"));

    expect(() => model.nextIntent(round(2, [tier1Candidate], "anything"))).toThrow(/exhausted/);
  });

  it("has the same power as a real model: usable anywhere the NegotiationModel interface is expected", async () => {
    // Bound to the interface type, not the concrete class, so this proves the
    // scripted double is a drop-in NegotiationModel, not merely a lookalike.
    // `await`ed because the interface permits an async implementation, even
    // though this scripted one happens to resolve synchronously.
    const model: NegotiationModel = new ScriptedNegotiationModel(script);
    const intent = await model.nextIntent(round(1, [tier1Candidate], "anything"));

    expect(intent.candidateId).toBe("cand_tier1_bundle");
  });
});
