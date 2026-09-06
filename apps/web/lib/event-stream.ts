/**
 * TICKET-502 — Live negotiation event stream.
 *
 * The pure shaping layer between the ledger read API
 * (`audit.getSessionLedger`) and the merchant's watch-only view. Ordering,
 * transition rendering and payload flattening live here so the React
 * component is a plain `.map` over the result — and so "a full event
 * sequence renders correctly" is a pure, runner-light assertion (see
 * `tests/event-stream.test.tsx`).
 *
 * Money stays in minor units here (CONTRACTS.md §3 — rupees are formatted
 * only at the React render boundary); rows carry `amountMinor` and
 * `EventRow` does the formatting.
 *
 * PRD §13: the reason code is THE justification and is surfaced raw, never
 * paraphrased. The model explanation is carried through verbatim but is
 * always marked non-authoritative.
 */

import type { ReasonCode } from "@repo/policy/contracts";
import { TERMINAL_STATES } from "@repo/policy/contracts";
import type { RouterOutputs } from "@repo/trpc/client";

export type LedgerEvent = RouterOutputs["audit"]["getSessionLedger"]["events"][number];

/**
 * Visual weight for a reason code — purely cosmetic; the code itself is
 * always shown, this only picks how loudly. The map is keyed by the frozen
 * `ReasonCode` enum (`packages/policy/contracts/reason-codes.ts`), so a
 * renamed or added code is a compile error here, not a silent downgrade to
 * grey.
 */
export type ReasonTone = "positive" | "negative" | "warning" | "neutral";

const REASON_TONE: Record<ReasonCode, ReasonTone> = {
  // A deal closed, money moved the right way.
  OFFER_ACCEPTED: "positive",
  HOLD_COMMITTED: "positive",
  ORDER_CREATED: "positive",
  PAYMENT_CAPTURED: "positive",

  // A door closed: walk-away, a binding cap, or a hard failure.
  WALK_AWAY: "negative",
  BUYER_DECLINED: "negative",
  DILUTION_EXCEEDS_PER_DEAL_CAP: "negative",
  CAMPAIGN_BUDGET_EXHAUSTED: "negative",
  ROUND_LIMIT_REACHED: "negative",
  NO_FEASIBLE_BASKET: "negative",
  FLOOR_BREACH: "negative",
  PAYMENT_FAILED: "negative",
  AUTONOMOUS_PAYMENT_NOT_AUTHORIZED: "negative",
  NOT_AT_RISK: "negative",
  NEGOTIATION_DISABLED: "negative",
  SKU_NOT_NEGOTIABLE: "negative",

  // Something needs an eye but the negotiation is still live.
  TIER1_REFUSED_BY_BUYER: "warning",
  OFFER_EXPIRED: "warning",
  OFFER_ALREADY_CONSUMED: "warning",
  BASKET_MISMATCH: "warning",
  HOLD_RELEASED: "warning",
  RAIL_STATE_DIVERGENCE: "warning",

  // Ordinary forward progress.
  SESSION_FLAGGED_AT_RISK: "neutral",
  NEGOTIATION_OPENED: "neutral",
  CANDIDATES_EVALUATED: "neutral",
  TIER1_OFFERED: "neutral",
  DILUTION_WITHIN_CAPS: "neutral",
  HOLD_RESERVED: "neutral",
};

export function reasonTone(reasonCode: string): ReasonTone {
  return REASON_TONE[reasonCode as ReasonCode] ?? "neutral";
}

const TERMINAL_STATE_SET = new Set<string>(TERMINAL_STATES);

/**
 * Whether the last event leaves the session in a terminal state — the
 * signal the view uses to stop polling ("a stream of ledger events for
 * active sessions").
 */
export function isStreamSettled(events: readonly LedgerEvent[]): boolean {
  if (events.length === 0) return false;
  const last = [...events].sort((a, b) => a.sequence - b.sequence).at(-1);
  return last !== undefined && TERMINAL_STATE_SET.has(last.toState);
}

/** Payload amounts stay in minor units; everything else is already a string. */
const MINOR_SUFFIX = /Minor$/;

export type PayloadField =
  | { label: string; text: string }
  | { label: string; amountMinor: number };

/** camelCase / snake_case payload key → human label, `Minor` suffix dropped. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(MINOR_SUFFIX, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Flatten a structured payload into ordered display fields. Nested objects
 * and arrays are JSON-stringified rather than dropped — the ledger payload
 * is the evidence and nothing in it should silently disappear from view.
 */
export function flattenPayload(payload: Record<string, unknown>): PayloadField[] {
  return Object.entries(payload).map(([key, value]) => {
    const label = humanizeKey(key);
    if (typeof value === "number" && MINOR_SUFFIX.test(key)) {
      return { label, amountMinor: value };
    }
    if (value === null || value === undefined) {
      return { label, text: "—" };
    }
    if (typeof value === "object") {
      return { label, text: JSON.stringify(value) };
    }
    return { label, text: String(value) };
  });
}

export type EventStreamRow = {
  key: string;
  sequence: number;
  /** Raw reason code — shown as-is, never paraphrased (PRD §13.2). */
  reasonCode: string;
  tone: ReasonTone;
  eventType: string;
  fromState: string | null;
  toState: string;
  /** `FROM → TO`, or just `TO` for the genesis event (no prior state). */
  transition: string;
  timestampIso: string;
  payloadFields: PayloadField[];
  policyVersion: number | null;
  offerId: string | null;
  campaignSpendMinor: number | null;
  modelExplanation: string | null;
};

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
      fromState: event.fromState,
      toState: event.toState,
      transition: event.fromState ? `${event.fromState} → ${event.toState}` : event.toState,
      timestampIso: event.timestamp,
      payloadFields: flattenPayload(event.payload),
      policyVersion: event.policyVersion,
      offerId: event.offerId,
      campaignSpendMinor: event.campaignSpendMinor,
      modelExplanation: event.modelExplanation,
    }));
}
