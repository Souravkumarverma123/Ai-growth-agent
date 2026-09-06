import Link from "next/link";

import { MerchantOfferStatus } from "./offer-status-panel";

/**
 * TICKET-504 — Offer status and TTL display (PRD §10, Q13).
 *
 * "Show the offer perishing." A read-only view of the offer(s) minted for
 * one session — status, remaining TTL, tier, campaign spend — polled a
 * couple of seconds at a time with a local 1s countdown. Nothing here
 * changes the negotiation (RA-1).
 */
export default async function MerchantSessionOffersPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Offer status</h1>
          <p className="text-muted-foreground text-sm">
            Session <span className="font-mono">{sessionId}</span>. The current offer and how long
            it has left before it perishes. Watching only — nothing here changes the negotiation.
          </p>
          <p className="text-muted-foreground mt-2 flex gap-3 text-sm">
            <Link href={`/merchant/sessions/${sessionId}`} className="underline underline-offset-2">
              ← Live event stream
            </Link>
            <Link
              href={`/merchant/sessions/${sessionId}/audit`}
              className="underline underline-offset-2"
            >
              Audit trail →
            </Link>
          </p>
        </div>
        <MerchantOfferStatus sessionId={sessionId} />
      </div>
    </main>
  );
}
