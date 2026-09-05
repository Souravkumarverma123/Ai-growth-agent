import { describe, expect, it } from "vitest";
import type { NegotiationIntent } from "@repo/policy";
import { ScriptedNegotiationModel } from "../model";
import { fakeCandidate } from "./support/fake-candidate";

/**
 * TICKET-201 acceptance criterion: "terminal_action accepts only WALK_AWAY."
 *
 * `NegotiationModel.nextIntent` returns the frozen `NegotiationIntent` type
 * unmodified, so this is enforced structurally by `terminalAction?:
 * "WALK_AWAY"` in `packages/policy/contracts/intent.ts` — this test proves
 * that guarantee holds for THIS package's interface, both at compile time
 * (the `@ts-expect-error` below is checked by `pnpm check-types`) and at
 * runtime (a scripted model actually producing the value).
 */
describe("terminalAction accepts only WALK_AWAY", () => {
  it("WALK_AWAY compiles and round-trips through the interface", () => {
    const intent: NegotiationIntent = {
      candidateId: "cand_final",
      messageFrame: "FINAL_POSITION",
      terminalAction: "WALK_AWAY",
    };
    expect(intent.terminalAction).toBe("WALK_AWAY");
  });

  it("any other literal fails to compile", () => {
    const intent: NegotiationIntent = {
      candidateId: "cand_final",
      messageFrame: "FINAL_POSITION",
      // @ts-expect-error -- terminalAction accepts only the literal "WALK_AWAY",
      // enforced by the frozen NegotiationIntent type this package returns
      // unmodified; no other terminal action is constructible.
      terminalAction: "ACCEPT_ANY_PRICE",
    };
    expect(intent).toBeDefined();
  });

  it("a scripted model producing a terminal round returns exactly WALK_AWAY, never anything else", () => {
    const candidate = fakeCandidate({ candidateId: "cand_final" });
    const model = new ScriptedNegotiationModel([
      { candidateId: "cand_final", messageFrame: "BUNDLE_VALUE" },
      { candidateId: "cand_final", messageFrame: "FINAL_POSITION", terminalAction: "WALK_AWAY" },
    ]);

    model.nextIntent({ sessionId: "s1", roundIndex: 1, candidates: [candidate], conversation: [] });
    const final = model.nextIntent({
      sessionId: "s1",
      roundIndex: 2,
      candidates: [candidate],
      conversation: [],
    });

    expect(final.terminalAction).toBe("WALK_AWAY");
  });
});
