import { MerchantCampaignBudget } from "./campaign-budget-countdown";

/**
 * TICKET-503 — Campaign budget countdown (PRD §6.5).
 *
 * "The visible number that makes 'bounded' concrete." A read-only view of the
 * merchant's campaign budget — total, committed, reserved, available — that
 * updates as Tier 2 holds move through their lifecycle. Nothing here changes
 * the budget; that is the policy page's job (RA-1).
 */

/**
 * The demo ships with exactly one merchant (`packages/database/seed.ts`'s
 * `SEED_MERCHANT_ID`). Hardcoded here for the same reason the TICKET-501
 * policy console hardcodes it — a fixed, well-known id, not something that
 * needs a live database read from the web app.
 */
const DEMO_MERCHANT_ID = "212eda77-06c0-46ef-ae17-24b6d4088188";

export default function MerchantCampaignBudgetPage() {
  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Campaign budget</h1>
          <p className="text-muted-foreground text-sm">
            How much dilutive headroom the agent has left. Updates every couple of seconds as Tier 2
            offers are minted and expire. Watching only — the budget is set on the policy page.
          </p>
        </div>
        <MerchantCampaignBudget merchantId={DEMO_MERCHANT_ID} />
      </div>
    </main>
  );
}
