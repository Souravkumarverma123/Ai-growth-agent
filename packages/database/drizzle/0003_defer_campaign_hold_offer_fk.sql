-- Custom SQL migration file, put your code below! --

-- TICKET-204 fix. `propose` (packages/trpc/server/routes/negotiation/route.ts)
-- must reserve a Tier 2 offer's campaign budget BEFORE minting — mintOffer
-- requires the reservation's outcome (offerId included) as a plain input, so
-- the offer itself cannot exist yet when `campaign_holds` gets its row. With
-- this FK checked immediately (the default), every Tier 2 proposal violated
-- it: no `offers` row exists yet for the freshly-generated `offerId` at the
-- moment `reserveCampaignBudget` inserts the hold that references it.
--
-- Deferring the check to transaction COMMIT (not disabling it) is the fix:
-- the route now performs the reservation and the later `offers` insert
-- inside one transaction, so by commit time the referenced row exists and
-- the constraint's actual guarantee — a hold can never outlive or outreach
-- its offer — is unchanged.
ALTER TABLE "campaign_holds" DROP CONSTRAINT "campaign_holds_offer_id_offers_id_fk";
--> statement-breakpoint
ALTER TABLE "campaign_holds" ADD CONSTRAINT "campaign_holds_offer_id_offers_id_fk"
  FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id")
  ON DELETE no action ON UPDATE no action
  DEFERRABLE INITIALLY DEFERRED;
