import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuditTrailView } from "~/app/merchant/sessions/[sessionId]/audit/merchant-audit-trail";
import {
  extractCandidateCounts,
  summarizeChain,
  toAuditTrailRows,
  type ChainVerification,
  type LedgerEvent,
} from "~/lib/audit-trail";

/**
 * TICKET-505 — "Renders the full worked-example run."
 *
 * Same PRD §18.2 worked example the live-stream test (TICKET-502) and the
 * ledger-route test (TICKET-404) both use: flag at risk → open → evaluate →
 * tier 1 → buyer refuses → tier 2 within caps → hold reserved → buyer
 * accepts.
 */

function ledgerEvent(
  overrides: Partial<LedgerEvent> & Pick<LedgerEvent, "sequence" | "reasonCode">,
): LedgerEvent {
  return {
    eventId: `evt-${overrides.sequence}`,
    timestamp: new Date(Date.UTC(2026, 8, 6, 10, 0, overrides.sequence)).toISOString(),
    eventType: "STATE_TRANSITION",
    fromState: "OPEN",
    toState: "OPEN",
    payload: {},
    policyVersion: null,
    offerId: null,
    campaignSpendMinor: null,
    modelExplanation: null,
    modelExplanationIsAuthoritative: false,
    prevHash: overrides.sequence === 0 ? null : `hash-${overrides.sequence - 1}`,
    eventHash: `hash-${overrides.sequence}`,
    ...overrides,
  };
}

const WORKED_EXAMPLE: LedgerEvent[] = [
  ledgerEvent({
    sequence: 0,
    eventType: "ELIGIBILITY_RULES_MATCH",
    fromState: "IDLE",
    toState: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
    payload: { cartAgeSeconds: 900 },
  }),
  ledgerEvent({
    sequence: 1,
    eventType: "NEGOTIATION_REQUESTED",
    fromState: "AT_RISK",
    toState: "OPEN",
    reasonCode: "NEGOTIATION_OPENED",
    policyVersion: 1,
  }),
  ledgerEvent({
    sequence: 2,
    eventType: "CANDIDATES_GENERATED",
    reasonCode: "CANDIDATES_EVALUATED",
    payload: { evaluated: 12, feasible: 9, tier1: 4 },
  }),
  ledgerEvent({
    sequence: 3,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "TIER1_OFFERED",
    payload: { candidateId: "cand-bundle-1", totalMinor: 302_000 },
    modelExplanation: "Offered the three-item bundle at a contribution-neutral price.",
  }),
  ledgerEvent({
    sequence: 4,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "TIER1_REFUSED_BY_BUYER",
    payload: { candidateId: "cand-bundle-1" },
  }),
  ledgerEvent({
    sequence: 5,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "DILUTION_WITHIN_CAPS",
    payload: { candidateId: "cand-original-cart", shortfallMinor: 20_000 },
    campaignSpendMinor: 20_000,
  }),
  ledgerEvent({
    sequence: 6,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
    payload: { amountMinor: 20_000 },
    campaignSpendMinor: 20_000,
  }),
  ledgerEvent({
    sequence: 7,
    eventType: "BUYER_ACCEPTS",
    fromState: "OFFER_PENDING",
    toState: "ACCEPTED",
    reasonCode: "OFFER_ACCEPTED",
    payload: { candidateId: "cand-original-cart" },
    modelExplanation: "Buyer accepted the original cart at the reduced price.",
  }),
];

const REASON_CODES_IN_ORDER = [
  "SESSION_FLAGGED_AT_RISK",
  "NEGOTIATION_OPENED",
  "CANDIDATES_EVALUATED",
  "TIER1_OFFERED",
  "TIER1_REFUSED_BY_BUYER",
  "DILUTION_WITHIN_CAPS",
  "HOLD_RESERVED",
  "OFFER_ACCEPTED",
];

const VALID_CHAIN: ChainVerification = {
  valid: true,
  eventCount: 8,
  brokenAtSequence: null,
  selfAnchored: true,
};

describe("extractCandidateCounts", () => {
  it("reads the spec-shaped payload (evaluated / feasible / tier1) as a full set", () => {
    const counts = extractCandidateCounts(WORKED_EXAMPLE)!;
    expect(counts.completeness).toBe("full");
    expect(counts.counts).toEqual([
      { key: "evaluated", label: "Evaluated", value: 12 },
      { key: "feasible", label: "Feasible", value: 9 },
      { key: "tier1", label: "Tier 1", value: 4 },
    ]);
  });

  it("reads the deployed engine's counts (evaluatedCount / selfFundingCount) and marks the missing feasible count partial (ISSUE-021)", () => {
    const events = [
      ledgerEvent({
        sequence: 2,
        reasonCode: "CANDIDATES_EVALUATED",
        payload: {
          evaluatedCount: 12,
          selfFundingCount: 4,
          byMoveType: { PRICE_CONCESSION: 1, ADD_SKU: 3 },
        },
      }),
    ];
    const counts = extractCandidateCounts(events)!;
    expect(counts.completeness).toBe("partial");
    expect(counts.counts.map((c) => c.value)).toEqual([12, null, 4]);
  });

  it("returns null when the session never reached candidate generation", () => {
    expect(extractCandidateCounts(WORKED_EXAMPLE.slice(0, 2))).toBeNull();
  });
});

describe("summarizeChain", () => {
  it("reports a clean chain and always discloses the self-anchoring limitation", () => {
    const summary = summarizeChain(VALID_CHAIN);
    expect(summary.status).toBe("verified");
    expect(summary.label).toBe("Chain verified");
    expect(summary.detail).toMatch(/self-anchored/i);
    expect(summary.detail).toMatch(/PRD §13\.3/);
  });

  it("names the sequence a broken chain first fails at", () => {
    const summary = summarizeChain({
      valid: false,
      eventCount: 8,
      brokenAtSequence: 5,
      selfAnchored: true,
    });
    expect(summary.status).toBe("broken");
    expect(summary.detail).toMatch(/#5/);
  });

  it("treats an empty ledger as its own state, not a broken chain", () => {
    const summary = summarizeChain({
      valid: true,
      eventCount: 0,
      brokenAtSequence: null,
      selfAnchored: true,
    });
    expect(summary.status).toBe("empty");
  });
});

describe("AuditTrailView", () => {
  function renderFullRun(overrides: Partial<Parameters<typeof AuditTrailView>[0]> = {}) {
    return render(
      <AuditTrailView
        rows={toAuditTrailRows(WORKED_EXAMPLE)}
        chain={summarizeChain(VALID_CHAIN)}
        candidateCounts={extractCandidateCounts(WORKED_EXAMPLE)}
        {...overrides}
      />,
    );
  }

  it("renders every event of the worked-example run, each reason code prominent and in order", () => {
    renderFullRun();

    const items = document.querySelectorAll("li[data-reason-code]");
    expect([...items].map((el) => el.getAttribute("data-reason-code"))).toEqual(
      REASON_CODES_IN_ORDER,
    );
    for (const code of REASON_CODES_IN_ORDER) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
  });

  it("displays chain validity, including the self-anchored disclosure", () => {
    renderFullRun();
    const indicator = screen.getByTestId("chain-verification");
    expect(within(indicator).getByText("Chain verified")).toBeInTheDocument();
    expect(within(indicator).getByText(/self-anchored/i)).toBeInTheDocument();
    expect(within(indicator).getByText(/PRD §13\.3/)).toBeInTheDocument();
  });

  it("shows a broken chain loudly", () => {
    renderFullRun({
      chain: summarizeChain({
        valid: false,
        eventCount: 8,
        brokenAtSequence: 5,
        selfAnchored: true,
      }),
    });
    const indicator = screen.getByTestId("chain-verification");
    expect(within(indicator).getByText("Chain broken")).toBeInTheDocument();
    expect(indicator.getAttribute("data-status")).toBe("broken");
  });

  it("surfaces the candidate counts — evaluated, feasible, Tier 1", () => {
    renderFullRun();
    const counts = screen.getByTestId("candidate-counts");
    expect(within(counts).getByText("Evaluated").parentElement).toHaveTextContent("12");
    expect(within(counts).getByText("Feasible").parentElement).toHaveTextContent("9");
    expect(within(counts).getByText("Tier 1").parentElement).toHaveTextContent("4");
  });

  it("marks a candidate count that was not recorded rather than inventing one", () => {
    renderFullRun({
      candidateCounts: extractCandidateCounts([
        ledgerEvent({
          sequence: 2,
          reasonCode: "CANDIDATES_EVALUATED",
          payload: { evaluatedCount: 12, selfFundingCount: 4 },
        }),
      ]),
    });
    const counts = screen.getByTestId("candidate-counts");
    expect(within(counts).getByText("Feasible").parentElement).toHaveTextContent("—");
    expect(within(counts).getByText(/not recorded/i)).toBeInTheDocument();
  });

  it("distinguishes the model explanation from the justification and flags it non-authoritative", () => {
    renderFullRun();
    const acceptedRow = document.querySelector('li[data-reason-code="OFFER_ACCEPTED"]')! as HTMLElement;

    // The justification (reason code) and the explanation are separate blocks.
    const explanation = within(acceptedRow).getByTestId("model-explanation");
    expect(explanation).toHaveTextContent(/Buyer accepted the original cart/);
    expect(within(explanation).getByText(/non-authoritative/i)).toBeInTheDocument();
    expect(explanation).not.toHaveTextContent("OFFER_ACCEPTED");
  });

  it("does not render an explanation block for events that carry none", () => {
    renderFullRun();
    const openedRow = document.querySelector('li[data-reason-code="NEGOTIATION_OPENED"]')! as HTMLElement;
    expect(within(openedRow).queryByTestId("model-explanation")).not.toBeInTheDocument();
  });

  it("renders loading and error states without any rows", () => {
    const { rerender } = render(
      <AuditTrailView rows={[]} chain={null} candidateCounts={null} isLoading />,
    );
    expect(screen.getByText(/Loading the audit trail/)).toBeInTheDocument();

    rerender(
      <AuditTrailView
        rows={[]}
        chain={null}
        candidateCounts={null}
        isError
        errorMessage="boom"
      />,
    );
    expect(screen.getByText(/Could not load the audit trail: boom/)).toBeInTheDocument();
    expect(document.querySelectorAll("li[data-reason-code]")).toHaveLength(0);
  });
});
