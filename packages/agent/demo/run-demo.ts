import type { ConversationTurn } from "../model";
import { renderBuyerSystemPrompt } from "../buyer";
import { CLOSING_RUN, WALK_AWAY_RUN, runDocumentedDemoNegotiations } from "./demo-runs";
import type { DemoNegotiationResult } from "./negotiation-harness";

/**
 * TICKET-206 — `pnpm --filter @repo/agent demo`.
 *
 * Prints the buyer agent's system prompt (so a viewer can see it contains no
 * script) and then the two documented negotiations side by side — one
 * closing, one walking away, from the same prompt and the same seed with
 * only the hidden budget changed.
 *
 * Importing this module never runs it; only executing the file does.
 */

function printTranscript(transcript: readonly ConversationTurn[]): void {
  for (const turn of transcript) {
    const who = turn.role === "buyer" ? "buyer " : "seller";
    console.log(`  ${who} │ ${turn.content}`);
  }
}

function printRun(label: string, budgetMinor: number, result: DemoNegotiationResult): void {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${label}  (hidden budget: ${budgetMinor} minor units)`);
  console.log("─".repeat(72));
  printTranscript(result.transcript);
  console.log(
    `\n  → outcome: ${result.outcome}` +
      (result.settledOffer
        ? ` at ${result.settledOffer.totalMinor} minor units (tier ${result.settledOffer.tier})`
        : ""),
  );
}

async function main(): Promise<void> {
  console.log("BUYER AGENT SYSTEM PROMPT");
  console.log("═".repeat(72));
  console.log(renderBuyerSystemPrompt(CLOSING_RUN.constraints));

  const { closing, walkAway } = await runDocumentedDemoNegotiations();
  printRun("RUN 1 — deal closes", CLOSING_RUN.constraints.budgetMinor, closing);
  printRun("RUN 2 — buyer walks away", WALK_AWAY_RUN.constraints.budgetMinor, walkAway);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
