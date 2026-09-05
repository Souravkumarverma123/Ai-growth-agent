import type { NegotiationIntent } from "@repo/policy";
import type { NegotiationModel, NegotiationRoundInput } from "./negotiation-model";

/**
 * Seam 2's test double (CONTRACTS.md §8): "faithful by construction because
 * the intent carries no numbers." Anything downstream of a `NegotiationModel`
 * only ever reads `candidateId` / `messageFrame` / `terminalAction` — there
 * is no number a real model could get right that this one could get wrong,
 * so a scripted sequence has the same power as a real model for any test
 * that exercises the engine, not the model's judgement.
 *
 * Configured with a fixed, ordered sequence of intents (constructor
 * argument). Each call to `nextIntent` returns the next one in order,
 * regardless of the `input` passed — that is what makes it deterministic and
 * lets a test drive a full multi-round negotiation (propose, propose again,
 * WALK_AWAY) and assert on the exact resulting sequence.
 */
export class ScriptedNegotiationModel implements NegotiationModel {
  private cursor = 0;

  constructor(private readonly script: readonly NegotiationIntent[]) {
    if (script.length === 0) {
      throw new Error("ScriptedNegotiationModel requires at least one scripted intent.");
    }
  }

  /** How many scripted intents have been returned so far. */
  get callCount(): number {
    return this.cursor;
  }

  /** True once every scripted intent has been returned. */
  get isExhausted(): boolean {
    return this.cursor >= this.script.length;
  }

  /**
   * Returns the next scripted intent. `input` is accepted only to satisfy
   * `NegotiationModel` — a real implementation reads it; this one does not
   * need to, because the whole point of a scripted double is that its
   * output is fixed in advance, not derived from what it is given.
   */
  nextIntent(input: NegotiationRoundInput): NegotiationIntent {
    void input; // Required by the NegotiationModel interface; unused by design (see class doc).
    const intent = this.script[this.cursor];
    if (!intent) {
      throw new Error(
        `ScriptedNegotiationModel: script exhausted after ${this.script.length} call(s) — ` +
          "the caller drove more negotiation rounds than were scripted for.",
      );
    }
    this.cursor += 1;
    return intent;
  }
}
