/**
 * TICKET-304 — `RailStateSource` (PRD §12, CONTRACTS.md §8's Seam 3: "there
 * are three [seams], and no more should be introduced").
 *
 * ============================================================================
 * WHY AN INTERFACE, NOT A DIRECT RAZORPAY CALL
 * ============================================================================
 * PRD §12: "Rail state is read through a `RailStateSource` interface with a
 * polling implementation." This is the ONLY seam this package's reconciler
 * (`./reconcile-order.ts`) is allowed to depend on — CONTRACTS.md is explicit
 * that tests may inject a scripted implementation here to "force captured /
 * failed / divergent [outcomes] deterministically", the same way
 * `NegotiationModel` lets `packages/agent`'s tests script an intent without
 * a real model call. Every other piece of the reconciliation path (Postgres,
 * the audit ledger, the campaign-hold lifecycle) runs for real in tests —
 * CONTRACTS.md §8's "do not mock the database" — only the actual network
 * call to Razorpay is swappable, and only through this one typed seam.
 *
 * `./razorpay-rail-state-source.ts` is this interface's one production
 * implementation (TICKET-304's own acceptance criterion: "the interface has
 * exactly one implementation in the MVP, and the seam is obvious").
 *
 * ============================================================================
 * WHY THIS ONLY EVER READS
 * ============================================================================
 * PRD §12: "Reconciliation is one-directional: the rail's state overwrites
 * local belief, always." A `RailStateSource` implementation therefore never
 * writes anything back to the rail — no capture, no charge, no refund call
 * exists anywhere in this package (see `./razorpay-client.ts`'s own doc, and
 * `../tests/no-capture-call.test.ts`, which this file's own name and every
 * export below are written to keep passing).
 */

/**
 * Mirrors `packages/database/models/payment.ts`'s frozen `railStateEnum`
 * exactly — this is deliberately the same four values, not a payments-local
 * vocabulary, so a `RailOrderReport` can be written straight onto an
 * `orders` row without a translation step that could silently drift from
 * the schema.
 */
export type RailState = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED";

export type RailOrderReport = {
  railState: RailState;
  /** Only present when `railState === "CAPTURED"` — the actual amount the
   *  rail's most-advanced payment attempt captured, in minor units. Lets a
   *  caller compare it against what it expected without needing to parse
   *  `payload` itself (a Razorpay-shaped structure this module's own
   *  implementation already knows how to read). */
  capturedAmountMinor?: number;
  /** The rail's raw response, kept for human reconciliation — copied
   *  verbatim onto `orders.railPayload`. */
  payload: Record<string, unknown>;
};

/**
 * The one thing a caller may ask the payment rail: "what do you currently
 * believe about this order?" `railOrderId` is Razorpay's own order id
 * (`orders.railOrderId`, `SelectOrder`) — never our local `orders.id`, since
 * the rail has no notion of that.
 */
export interface RailStateSource {
  getOrderState(railOrderId: string): Promise<RailOrderReport>;
}
