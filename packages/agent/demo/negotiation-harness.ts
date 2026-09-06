import {
  assignTiersAndFeasibility,
  computeCounterfactualContribution,
  generateCandidates,
  type CampaignBudgetReservationOutcome,
  type Candidate,
  type Offer,
} from "@repo/policy";

import type { ConversationTurn } from "../model";
import {
  applyOfferDeclined,
  runNegotiationRound,
  selectExposedCandidates,
  INITIAL_ROUND_STATE,
  type RoundState,
} from "../orchestration";
import { BuyerAgent, type BuyerAgentOptions } from "../buyer";
import type { BuyerConstraints } from "../buyer";
import { createSeededRandom, randomUuid } from "../buyer/seeded-random";
import { DemoMerchantModel } from "./demo-merchant-model";
import { REFERENCE_SCENARIO, type ReferenceScenario } from "./reference-scenario";

/**
 * TICKET-206 — the buyer agent harness / demo harness (PRD §18, §18.1).
 *
 * Pairs a {@link BuyerAgent} (hidden budget, no script) against the real
 * deterministic engine — `generateCandidates -> assignTiersAndFeasibility ->
 * runNegotiationRound` (`@repo/policy` + TICKET-202's orchestration loop) —
 * and runs the negotiation to a terminal state. Pure: no database, no HTTP,
 * no model SDK. `packages/agent`'s only engine entry point is `mintOffer`
 * (reached here through `runNegotiationRound`), so this stays inside
 * boundary rule B2 (CONTRACTS.md §2).
 *
 * Campaign-budget accounting is tracked in-memory here (`available = total -
 * reserved - committed`, PRD §6.5) because there is no `campaign_holds`
 * table in a pure run — a Tier 2 offer reserves its shortfall for the round,
 * releases it on a decline or walk, and commits it on acceptance, exactly as
 * `packages/database`'s hold lifecycle would (TICKET-108). The reservation
 * outcome handed to `mintOffer` carries the real shortfall amount, so the
 * signed offer's `campaignSpendMinor` still matches its (virtual) hold.
 *
 * Given `(constraints, seed)` the whole run is reproducible — the seed only
 * ever varies message wording, never a decision or an amount. "Two seeded
 * runs produce the two documented outcomes" is this file's reason to exist.
 */

export type DemoOutcome = "CLOSED" | "WALKED_AWAY" | "ROUND_LIMIT_REACHED" | "NO_FEASIBLE_BASKET";

/** One offer the merchant agent put on the table, for transcript display. */
export interface DemoMerchantOffer {
  readonly roundIndex: number;
  readonly totalMinor: number;
  /** Merchant-side detail — shown in the harness result for demo narration,
   *  never sent to the buyer agent (see {@link runDemoNegotiation}). */
  readonly tier: 1 | 2;
  readonly reasonCode: string;
}

export interface DemoNegotiationResult {
  readonly outcome: DemoOutcome;
  /** The offer the buyer accepted, if any. */
  readonly settledOffer: Offer | null;
  /** Number of merchant offers made. */
  readonly rounds: number;
  /** Full buyer/agent transcript, oldest first. */
  readonly transcript: readonly ConversationTurn[];
  /** Every offer the merchant agent made, in order. */
  readonly merchantOffers: readonly DemoMerchantOffer[];
  /** The buyer's system prompt — displayable, verifiably script-free. */
  readonly buyerSystemPrompt: string;
}

export interface DemoNegotiationConfig {
  readonly constraints: BuyerConstraints;
  /** Fully determines the run with the constraints. Default 1. */
  readonly seed?: number;
  /** Passed to {@link BuyerAgent}. */
  readonly patience?: BuyerAgentOptions["patience"];
  /** Defaults to PRD §18.2's reference scenario. */
  readonly scenario?: ReferenceScenario;
  /** Mint time; defaults to a fixed instant so runs are reproducible. */
  readonly now?: Date;
  readonly signingSecret?: string;
}

const SESSION_ID = "de300000-0000-4000-8000-000000000000";
const DEFAULT_NOW = new Date("2026-09-06T00:00:00.000Z");
const DEFAULT_SIGNING_SECRET = "demo-harness-signing-secret";

export async function runDemoNegotiation(
  config: DemoNegotiationConfig,
): Promise<DemoNegotiationResult> {
  const scenario = config.scenario ?? REFERENCE_SCENARIO;
  const { policy, catalogue, originalBasket } = scenario;
  const now = config.now ?? DEFAULT_NOW;
  const signingSecret = config.signingSecret ?? DEFAULT_SIGNING_SECRET;

  const counterfactualContributionMinor = computeCounterfactualContribution(originalBasket, catalogue);

  const buyer = new BuyerAgent(config.constraints, {
    seed: config.seed ?? 1,
    patience: config.patience,
  });
  const merchantModel = new DemoMerchantModel();
  // A generator distinct from the buyer's, so a virtual hold's offer id does
  // not perturb the buyer's message wording (or vice versa).
  const holdIdRng = createSeededRandom((config.seed ?? 1) ^ 0x9e3779b9);

  let state: RoundState = INITIAL_ROUND_STATE;
  let reservedMinor = 0;
  let committedMinor = 0;

  const transcript: ConversationTurn[] = [{ role: "buyer", content: buyer.openingMessage() }];
  const merchantOffers: DemoMerchantOffer[] = [];

  const finish = (outcome: DemoOutcome, settledOffer: Offer | null): DemoNegotiationResult => ({
    outcome,
    settledOffer,
    rounds: merchantOffers.length,
    transcript,
    merchantOffers,
    buyerSystemPrompt: buyer.systemPrompt,
  });

  for (;;) {
    if (state.roundIndex > policy.maxRounds) {
      return finish("ROUND_LIMIT_REACHED", null);
    }

    const generation = generateCandidates({
      session: { originalBasket, counterfactualContributionMinor, roundIndex: state.roundIndex },
      policy,
      skuCatalogue: catalogue,
    });

    const availableCampaignBudgetMinor =
      policy.campaignBudgetTotalMinor - reservedMinor - committedMinor;

    const tiering = assignTiersAndFeasibility({
      candidates: generation.candidates,
      tier1Refused: state.tier1Refused,
      perDealCapMinor: policy.perDealCapMinor,
      availableCampaignBudgetMinor,
    });

    if (!tiering.feasible) {
      return finish("NO_FEASIBLE_BASKET", null);
    }

    const candidatesInRound: Candidate[] = tiering.candidates.map((candidate, index) => ({
      ...candidate,
      candidateId: `C${index + 1}`,
      sessionId: SESSION_ID,
      roundIndex: state.roundIndex,
    }));

    // Mirror `packages/trpc`'s route: decide the merchant's pick up front so a
    // Tier 2 reservation can be made before `mintOffer` needs it. The model is
    // deterministic on the same exposed set, so this never disagrees with what
    // `runNegotiationRound` re-derives internally.
    const exposedCandidates = selectExposedCandidates(candidatesInRound, state.tier1Refused);
    const previewIntent = merchantModel.nextIntent({
      sessionId: SESSION_ID,
      roundIndex: state.roundIndex,
      candidates: exposedCandidates,
      conversation: transcript,
    });
    const chosen = candidatesInRound.find((c) => c.candidateId === previewIntent.candidateId)!;

    let reservation: Extract<CampaignBudgetReservationOutcome, { reserved: true }> | undefined;
    if (chosen.tier === 2) {
      reservation = {
        reserved: true,
        offerId: randomUuid(holdIdRng),
        amountMinor: chosen.requiredCampaignSpendMinor,
      };
    }

    const round = await runNegotiationRound({
      sessionId: SESSION_ID,
      state,
      policyVersion: policy.policyVersion,
      candidatesInRound,
      conversation: transcript,
      model: merchantModel,
      now,
      offerTtlSeconds: policy.offerTtlSeconds,
      campaignBudgetReservation: reservation,
      signingSecret,
    });

    if (round.status === "WALKED_AWAY" || round.status === "MINT_REJECTED") {
      // Neither is reachable through `DemoMerchantModel` (it never emits
      // WALK_AWAY, and a Tier 2 pick is always one tiering just proved
      // feasible) — handled for exhaustiveness. No deal.
      return finish("WALKED_AWAY", null);
    }

    const offer = round.offer;
    if (reservation) {
      reservedMinor += reservation.amountMinor;
    }
    merchantOffers.push({
      roundIndex: state.roundIndex,
      totalMinor: offer.totalMinor,
      tier: offer.tier,
      reasonCode: offer.reasonCode,
    });
    transcript.push({ role: "agent", content: round.message });

    // The buyer sees only the buyer-facing shape of the offer.
    const action = buyer.reactToOffer({ totalMinor: offer.totalMinor, currency: offer.currency });
    transcript.push({ role: "buyer", content: action.message });

    if (action.kind === "ACCEPT") {
      if (reservation) {
        reservedMinor -= reservation.amountMinor;
        committedMinor += reservation.amountMinor;
      }
      return finish("CLOSED", offer);
    }

    // DECLINE or WALK_AWAY — a Tier 2 offer's virtual hold is released.
    if (reservation) {
      reservedMinor -= reservation.amountMinor;
    }

    if (action.kind === "WALK_AWAY") {
      return finish("WALKED_AWAY", null);
    }

    state = applyOfferDeclined(round.nextState, offer);
  }
}
