import Link from "next/link";

import { MerchantAuditTrail } from "./merchant-audit-trail";

/**
 * TICKET-505 — Audit trail display (PRD §13.2, §8; Q13, Q28).
 *
 * "The screen a judge will look at." A completed negotiation is fully
 * reconstructable from here: every ledger event with its reason code and
 * payload, the hash-chain verification (and its honest self-anchored
 * caveat), and the candidate counts that bound the search space. Read-only —
 * this reads the append-only ledger and nothing else.
 */
export default async function MerchantAuditTrailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Audit trail</h1>
          <p className="text-muted-foreground text-sm">
            Session <span className="font-mono">{sessionId}</span>. The complete, ordered ledger for
            this negotiation — reason codes, payloads, chain verification. Nothing here changes the
            negotiation.
          </p>
          <p className="text-muted-foreground mt-2 flex gap-3 text-sm">
            <Link
              href={`/merchant/sessions/${sessionId}`}
              className="underline underline-offset-2"
            >
              ← Live event stream
            </Link>
            <Link
              href={`/merchant/sessions/${sessionId}/offers`}
              className="underline underline-offset-2"
            >
              ← Offer status
            </Link>
          </p>
        </div>
        <MerchantAuditTrail sessionId={sessionId} />
      </div>
    </main>
  );
}
