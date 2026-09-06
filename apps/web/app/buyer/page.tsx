import { BuyerSessionEntry } from "./buyer-session-entry";

/**
 * TICKET-506 — Minimal buyer surface (PRD §9, §19).
 *
 * A negotiation is always addressed by its session id (there is no storefront
 * and no browsing — the merchant's own engine flags a checkout session, and
 * the buyer agent is handed that id). This entry screen only exists so a
 * human running the demo can paste in the id the harness printed and land on
 * the console for it. The console itself is `/buyer/[sessionId]`.
 */
export default function BuyerEntryPage() {
  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Buyer agent console</h1>
          <p className="text-muted-foreground text-sm">
            Open the negotiation your agent was handed. Paste the session id to continue.
          </p>
        </div>
        <BuyerSessionEntry />
      </div>
    </main>
  );
}
