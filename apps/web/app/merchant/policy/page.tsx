import { MerchantPolicyConsole } from "./merchant-policy-console";

/**
 * TICKET-501 — Merchant policy configuration and approval (PRD §5, §6.6,
 * §19). The screen where the merchant delegates authority: floors,
 * campaign budget, per-deal cap, and the three pre-computed commitment-value
 * bounds are edited here and approved as one unit; the kill switch sits
 * beside them but is wired independently (RA-1).
 */
export default function MerchantPolicyPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Merchant policy</h1>
          <p className="text-muted-foreground text-sm">
            Delegate authority to the negotiation agent. Approving here is the only moment a human
            grants it any authority.
          </p>
        </div>
        <MerchantPolicyConsole />
      </div>
    </main>
  );
}
