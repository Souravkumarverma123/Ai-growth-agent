/**
 * TICKET-502 — Live negotiation event stream.
 *
 * The pure shaping layer between the ledger read API
 * (`audit.getSessionLedger`) and the merchant's watch-only view. All the
 * ordering, transition rendering, payload flattening and reason-code
 * emphasis lives here so the React component is a plain `.map` over the
 * result — and so "a full event sequence renders correctly" is a pure,
 * runner-light assertion (see `tests/event-stream.test.ts`).
 *
 * PRD §13: the reason code is THE justification and is surfaced raw, never
 * paraphrased. The model explanation is carried through verbatim but is
 * always marked non-authoritative.
 */

import type { RouterOutputs } from "@repo/trpc/client";

import { formatRupees } from "~/lib/money";

export type LedgerEvent = RouterOutputs["audit"]["getSessionLedger"]["events"][number];

/**
 * Visual weight for a reason code. Purely presentational — the code itself
 * is always shown; this only picks how loudly. Grouped by the §14 phases
 * that matter to someone watching a negotiation unfold.
 */
export type ReasonTone = "positive" | "negative" | "warning" | "neutral";

const POSITIVE_REASONS = new Set<string>([
  "OFFER_ACCEPTED",
  "HOLD_COMMITTED",
  "PAYMENT_CAPTURED",
  "ORDER_CREATED",
]);

const NEGATIVE_REASONS = new Set<string>([
  "WALK_AWAY",
  "BUYER_DECLINED",
  "DILUTION_EXCEEDS_PER_DEAL_CAP",
  "CAMPAIGN_BUDGET_EXHAUSTED",
  "ROUND_LIMIT_REACHED",
  "NO_FEASIBLE_BASKET",
  "FLOOR_BREACH",
  "PAYMENT_FAILED",
  "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED",
  "NOT_AT_RISK",
  "NEGOTIATION_DISABLED",
  "SKU_NOT_NEGOTIABLE",
]);

const WARNING_REASONS = new Set<string>([
  "OFFER_EXPIRED",
  "OFFER_ALREADY_CONSUMED",
  "BASKET_MISMATCH",
  "HOLD_RELEASED",
  "RAIL_STATE_DIVERGENCE",
  "TIER1_REFUSED_BY_BUYER",
]);

export function reasonTone(reasonCode: string): ReasonTone {
  if (POSITIVE_REASONS.has(reasonCode)) return "positive";
  if (NEGATIVE_REASONS.has(reasonCode)) return "negative";
  if (WARNING_REASONS.has(reasonCode)) return "warning";
  return "neutral";
}

export type PayloadField = { label: string; value: string };

/** camelCase / snake_case payload key → human label. */
function humanizeKey(key: string): string {
  const withoutMinor = key.replace(/Minor$/, "");
  const spaced = withoutMinor
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatScalar(key: string, value: string | number | boolean): string {
  if (typeof value === "number" && /Minor$/.test(key)) {
    // The one place a payload amount becomes rupees — this module is only
    // ever consumed by the React view, so it is the render boundary.
    return formatRupees(value);
  }
  return String(value);
}

/**
 * Flatten a structured payload into ordered display fields. Nested objects
 * and arrays are JSON-stringified rather than dropped — the ledger payload
 * is the evidence and nothing in it should silently disappear from view.
 */
export function flattenPayload(payload: Record<string, unknown>): PayloadField[] {
  return Object.entries(payload).map(([key, value]) => {
    const label = humanizeKey(key);
    if (value === null || value === undefined) {
      return { label, value: "—" };
    }
    if (typeof value === "object") {
      return { label, value: JSON.stringify(value) };
    }
    return { label, value: formatScalar(key, value as string | number | boolean) };
  });
}

export type EventStreamRow = {
  key: string;
  sequence: number;
  /** Raw reason code — shown as-is, never paraphrased (PRD §13.2). */
  reasonCode: string;
  tone: ReasonTone;
  eventType: string;
  /** `FROM → TO`, or just `TO` for the genesis event (no prior state). */
  transition: string;
  timestampLabel: string;
  timestampIso: string;
  payloadFields: PayloadField[];
  policyVersion: number | null;
  offerId: string | null;
  campaignSpendMinor: number | null;
  campaignSpendLabel: string | null;
  modelExplanation: string | null;
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Shape a ledger read into rows for the stream view. Defensively sorted by
 * sequence — the API already returns genesis-first, but the view must not
 * depend on transport order to tell the story straight.
 */
export function toEventStreamRows(events: readonly LedgerEvent[]): EventStreamRow[] {
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => ({
      key: event.eventId,
      sequence: event.sequence,
      reasonCode: event.reasonCode,
      tone: reasonTone(event.reasonCode),
      eventType: event.eventType,
      transition: event.fromState ? `${event.fromState} → ${event.toState}` : event.toState,
      timestampLabel: formatTimestamp(event.timestamp),
      timestampIso: event.timestamp,
      payloadFields: flattenPayload(event.payload),
      policyVersion: event.policyVersion,
      offerId: event.offerId,
      campaignSpendMinor: event.campaignSpendMinor,
      campaignSpendLabel:
        event.campaignSpendMinor === null ? null : formatRupees(event.campaignSpendMinor),
      modelExplanation: event.modelExplanation,
    }));
}
