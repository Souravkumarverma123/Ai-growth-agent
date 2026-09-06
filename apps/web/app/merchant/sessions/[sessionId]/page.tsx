import { MerchantEventStream } from "./merchant-event-stream";

/**
 * TICKET-502 — Live negotiation event stream (PRD §13, Q13).
 *
 * "Let the merchant watch without approving." A read-only window onto one
 * session's append-only ledger, polled a couple of seconds at a time. There
 * is no control on this screen — the merchant's only lever over a running
 * negotiation is the kill switch on the policy page (RA-1).
 */
export default async function MerchantSessionStreamPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Negotiation monitor</h1>
          <p className="text-muted-foreground text-sm">
            Session <span className="font-mono">{sessionId}</span>. Watching only — nothing here
            changes the negotiation.
          </p>
        </div>
        <MerchantEventStream sessionId={sessionId} />
      </div>
    </main>
  );
}
