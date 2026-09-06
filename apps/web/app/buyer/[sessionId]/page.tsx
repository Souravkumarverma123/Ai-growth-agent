import { BuyerNegotiationConsole } from "./buyer-negotiation-console";

/**
 * TICKET-506 — Minimal buyer surface (PRD §9, §19).
 *
 * The buyer-facing view of one negotiation: the transcript, the current
 * offer, accept / decline, and — once an offer is accepted — the payment
 * authorization handoff. Minimal because the counterparty is an agent, not
 * because it is unfinished: there is no storefront, no cart editing, no
 * browsing. Everything here goes through the public buyer-facing tRPC
 * surface (`negotiation.*`), the same one a third-party agent would use.
 */
export default async function BuyerNegotiationPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Buyer agent console</h1>
          <p className="text-muted-foreground text-sm">
            Your agent negotiates against the merchant&apos;s frozen policy. You review the offer
            and authorize payment yourself — the agent never charges you.
          </p>
        </div>
        <BuyerNegotiationConsole sessionId={sessionId} />
      </div>
    </main>
  );
}
