import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EventStreamView } from "~/app/merchant/sessions/[sessionId]/merchant-event-stream";
import {
  flattenPayload,
  isStreamSettled,
  reasonTone,
  toEventStreamRows,
  type LedgerEvent,
} from "~/lib/event-stream";

/**
 * TICKET-502 — "Component renders a full event sequence."
 *
 * The sequence is the PRD §18.2 worked example, the same one TICKET-404's
 * ledger-route test reconstructs: flag at risk → open → evaluate → tier 1 →
 * buyer refuses → tier 2 within caps → hold reserved → buyer accepts.
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

describe("toEventStreamRows", () => {
  it("orders by sequence regardless of the order events arrive in", () => {
    const shuffled = [WORKED_EXAMPLE[5]!, WORKED_EXAMPLE[0]!, WORKED_EXAMPLE[7]!, WORKED_EXAMPLE[2]!];
    const rows = toEventStreamRows(shuffled);
    expect(rows.map((r) => r.sequence)).toEqual([0, 2, 5, 7]);
  });

  it("surfaces every reason code verbatim, in sequence order", () => {
    const rows = toEventStreamRows(WORKED_EXAMPLE);
    expect(rows.map((r) => r.reasonCode)).toEqual(REASON_CODES_IN_ORDER);
  });

  it("renders the genesis event without a phantom from-state", () => {
    const [genesis, second] = toEventStreamRows(WORKED_EXAMPLE);
    expect(genesis!.transition).toBe("IDLE → AT_RISK");
    expect(second!.transition).toBe("AT_RISK → OPEN");
  });

  it("keeps minor-unit payload amounts in paise and drops the Minor suffix from the label", () => {
    const rows = toEventStreamRows(WORKED_EXAMPLE);
    const tier1 = rows.find((r) => r.reasonCode === "TIER1_OFFERED")!;
    expect(tier1.payloadFields).toContainEqual({ label: "Total", amountMinor: 302_000 });

    const dilution = rows.find((r) => r.reasonCode === "DILUTION_WITHIN_CAPS")!;
    expect(dilution.payloadFields).toContainEqual({ label: "Shortfall", amountMinor: 20_000 });
    expect(dilution.campaignSpendMinor).toBe(20_000);
  });

  it("keeps candidate counts as plain integer text", () => {
    const rows = toEventStreamRows(WORKED_EXAMPLE);
    const evaluated = rows.find((r) => r.reasonCode === "CANDIDATES_EVALUATED")!;
    expect(evaluated.payloadFields).toEqual([
      { label: "Evaluated", text: "12" },
      { label: "Feasible", text: "9" },
      { label: "Tier1", text: "4" },
    ]);
  });

  it("carries the model explanation through untouched", () => {
    const rows = toEventStreamRows(WORKED_EXAMPLE);
    const accepted = rows.find((r) => r.reasonCode === "OFFER_ACCEPTED")!;
    expect(accepted.modelExplanation).toBe("Buyer accepted the original cart at the reduced price.");
  });
});

describe("isStreamSettled", () => {
  it("is false while the last event is non-terminal, true once it is terminal", () => {
    expect(isStreamSettled([])).toBe(false);
    expect(isStreamSettled(WORKED_EXAMPLE.slice(0, 3))).toBe(false);

    const walkedAway = [
      ...WORKED_EXAMPLE.slice(0, 5),
      ledgerEvent({
        sequence: 5,
        reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
      }),
    ];
    expect(isStreamSettled(walkedAway)).toBe(true);
  });
});

describe("reasonTone", () => {
  it("classifies acceptance as positive and a cap breach as negative", () => {
    expect(reasonTone("OFFER_ACCEPTED")).toBe("positive");
    expect(reasonTone("DILUTION_EXCEEDS_PER_DEAL_CAP")).toBe("negative");
    expect(reasonTone("WALK_AWAY")).toBe("negative");
    expect(reasonTone("OFFER_EXPIRED")).toBe("warning");
    expect(reasonTone("NEGOTIATION_OPENED")).toBe("neutral");
    expect(reasonTone("SOMETHING_UNKNOWN")).toBe("neutral");
  });
});

describe("flattenPayload", () => {
  it("stringifies nested structures rather than dropping them", () => {
    expect(flattenPayload({ hold: { id: "h1", amountMinor: 500 } })).toEqual([
      { label: "Hold", text: '{"id":"h1","amountMinor":500}' },
    ]);
  });
});

describe("EventStreamView", () => {
  it("renders the full worked-example sequence, every reason code in order", () => {
    render(<EventStreamView rows={toEventStreamRows(WORKED_EXAMPLE)} />);

    const items = document.querySelectorAll("li[data-reason-code]");
    expect([...items].map((el) => el.getAttribute("data-reason-code"))).toEqual(REASON_CODES_IN_ORDER);

    for (const code of REASON_CODES_IN_ORDER) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
  });

  it("formats payload amounts as rupees at the render boundary", () => {
    render(<EventStreamView rows={toEventStreamRows(WORKED_EXAMPLE)} />);
    const tier1Row = document.querySelector('li[data-reason-code="TIER1_OFFERED"]')!;
    expect(within(tier1Row as HTMLElement).getByText("₹3,020.00")).toBeInTheDocument();
  });

  it("shows the model explanation flagged as non-authoritative", () => {
    render(<EventStreamView rows={toEventStreamRows(WORKED_EXAMPLE)} />);

    const acceptedRow = document.querySelector('li[data-reason-code="OFFER_ACCEPTED"]')!;
    expect(within(acceptedRow as HTMLElement).getByText(/non-authoritative/i)).toBeInTheDocument();
    expect(
      within(acceptedRow as HTMLElement).getByText(/Buyer accepted the original cart/),
    ).toBeInTheDocument();
  });

  it("shows campaign spend on the events that moved a hold", () => {
    render(<EventStreamView rows={toEventStreamRows(WORKED_EXAMPLE)} />);

    const holdRow = within(document.querySelector('li[data-reason-code="HOLD_RESERVED"]')! as HTMLElement);
    expect(holdRow.getByText("Campaign spend")).toBeInTheDocument();
    expect(holdRow.getAllByText("₹200.00").length).toBeGreaterThanOrEqual(1);
  });

  it("reports a settled session instead of 'Live'", () => {
    render(<EventStreamView rows={toEventStreamRows(WORKED_EXAMPLE)} isSettled />);
    expect(screen.getByText("Settled")).toBeInTheDocument();
  });

  it("renders empty, loading and error states without any rows", () => {
    const { rerender } = render(<EventStreamView rows={[]} isLoading />);
    expect(screen.getByText(/Loading events/)).toBeInTheDocument();

    rerender(<EventStreamView rows={[]} isError errorMessage="boom" />);
    expect(screen.getByText(/Could not load the event stream: boom/)).toBeInTheDocument();

    rerender(<EventStreamView rows={[]} />);
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
    expect(document.querySelectorAll("li[data-reason-code]")).toHaveLength(0);
  });
});
