import "dotenv/config";

import type { Basket, CommitmentType } from "@repo/policy/contracts";
import { CURRENCY } from "@repo/policy/contracts";

import { and, eq, notInArray } from "drizzle-orm";

import { db } from "./index";
import {
  commitmentValuesTable,
  merchantPoliciesTable,
  merchantsTable,
  skuPoliciesTable,
} from "./schema";

/**
 * TICKET-507 — Seed data and demo fixtures (PRD §18.2, §5).
 *
 * One catalogue that tests and the demo both use. This is demo/test fixture
 * data, not a frozen contract — but the *shape* it is written through
 * (`merchantsTable`, `merchantPoliciesTable`, `commitmentValuesTable`,
 * `skuPoliciesTable`) is frozen (CONTRACTS.md §1); this file does not modify
 * any model in `packages/database/models/`.
 *
 * Idempotent by construction: every row this script owns is upserted by a
 * natural key —
 *   - the merchant and its policy, by their fixed ids (below)
 *   - commitment values, by the (merchantId, commitmentType) unique index
 *   - SKUs, by the (merchantId, sku) unique index
 * — so running it any number of times against the same database never
 * errors and never duplicates a row. It never reads or writes a table, or a
 * merchant id, it doesn't own — a pre-existing unrelated row (e.g. a
 * manually-inserted probe merchant) is left untouched.
 *
 * SKUs no longer present in SEED_CATALOGUE (removed, or renamed to a new
 * sku) are deleted after the upsert loop, so the seed merchant's sku_policies
 * rows always match this file exactly rather than accumulating stale entries
 * across revisions.
 */

// ---------------------------------------------------------------------------
// Fixed identifiers
// ---------------------------------------------------------------------------
// Deterministic (real v4 UUIDs, hand-fixed rather than `defaultRandom()`) so
// the reference cart fixture below, and any downstream ticket that wants to
// point at "the Vitamin C Serum row", can do so without a round trip, and so
// re-running this seed always upserts the exact same rows back into place.

export const SEED_MERCHANT_ID = "212eda77-06c0-46ef-ae17-24b6d4088188";
const SEED_MERCHANT_POLICY_ID = "e053f893-7731-4383-95a4-4a626e6113b3";
const SEED_MERCHANT_NAME = "Glow Theory";

export const SEED_SKU_IDS = {
  vitaminCSerum: "beb6d832-d269-4c76-b6e2-9d16fec26796",
  gentleCleanser: "9e1ce79a-b9e6-41d1-9aa8-438d6c2a0083",
  nightCream: "9c447ec1-3039-4d1f-b58e-ff97c557b501",
  hyaluronicAcidSerum: "9ba72a57-bacc-40df-abf7-b3f3da9cdc5d",
  niacinamideSerum: "699d97cc-afac-4b38-9f9b-4a86631b5ad8",
  retinolNightSerum: "cef4ffdd-dd36-46eb-af7f-177f3b446c10",
  foamingFaceWash: "825e68af-c867-4577-9735-cd4422f6bb8c",
  micellarWater: "456f015d-94a5-4fe5-9068-10a90b970006",
  clayDetoxMask: "0ac8e762-1c3e-4aa4-8c73-59ead61f0c97",
  sheetMaskSet: "2522b43c-87f1-4eca-bafa-c95af64f2bb2",
  spf50SunscreenGel: "c69736b6-47a4-4caa-8334-d92a33ed8478",
  underEyeCream: "a925a6fe-d409-411b-b367-e312a2f9b720",
  dayMoisturizer: "0ce6b549-0734-4c79-a803-81eefba18d1b",
  ahaBhaToner: "d3adbe2b-f389-4f4a-9030-fe25617461fa",
  rosewaterMist: "e0a46569-d871-4bfa-bbb5-67c475701c01",
  charcoalPeelMask: "5e3f23cf-0589-4df7-8146-73d392de594d",
  lipSleepingBalm: "58f13bfa-69bf-49a9-98bb-0c4b5895562b",
  bodyButterWhip: "934a1da6-ab73-4889-85bd-5c6c1c8460a5",
  antiAcneSpotGel: "d19c9445-b63e-4804-aed4-171a358c38e5",
  overnightRepairOil: "ba341dfb-a543-4691-b850-bf59eb094db6",
} as const;

// ---------------------------------------------------------------------------
// Catalogue — ~20 D2C skincare SKUs, exactly 3 flagged slow-moving.
//
// The first three are the named SKUs from PRD §18.2, reproduced with their
// exact list/floor prices — do not change these three. The remaining
// seventeen are invented to fill out a plausible catalogue, keeping floor at
// roughly the same 55–65% of list that the three given examples sit at
// (Serum 61.1%, Cleanser 64.3%, Night Cream 57.8%), so the catalogue reads as
// internally consistent. Two more of the seventeen are flagged slow-moving,
// for exactly three in the whole catalogue.
// ---------------------------------------------------------------------------

interface SeedSku {
  id: string;
  sku: string;
  name: string;
  listPriceMinor: number;
  floorPriceMinor: number;
  slowMoving: boolean;
  affinityGroup: string;
}

export const SEED_CATALOGUE: readonly SeedSku[] = [
  // --- PRD §18.2 named SKUs — exact figures the worked example depends on ---
  {
    id: SEED_SKU_IDS.vitaminCSerum,
    sku: "VITC-SERUM-30ML",
    name: "Vitamin C Serum",
    listPriceMinor: 180_000, // ₹1,800
    floorPriceMinor: 110_000, // ₹1,100 (61.1% of list)
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    id: SEED_SKU_IDS.gentleCleanser,
    sku: "GENTLE-CLNSR-100ML",
    name: "Gentle Cleanser",
    listPriceMinor: 70_000, // ₹700
    floorPriceMinor: 45_000, // ₹450 (64.3% of list)
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    id: SEED_SKU_IDS.nightCream,
    sku: "NIGHT-CREAM-50G",
    name: "Night Cream",
    listPriceMinor: 90_000, // ₹900
    floorPriceMinor: 52_000, // ₹520 (57.8% of list)
    slowMoving: true,
    affinityGroup: "moisturizers",
  },
  // --- invented catalogue, same ~55-65% floor/list band ---
  {
    id: SEED_SKU_IDS.hyaluronicAcidSerum,
    sku: "HYAL-SERUM-30ML",
    name: "Hyaluronic Acid Serum",
    listPriceMinor: 160_000,
    floorPriceMinor: 95_000,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    id: SEED_SKU_IDS.niacinamideSerum,
    sku: "NIACIN-SERUM-30ML",
    name: "Niacinamide 10% Serum",
    listPriceMinor: 65_000,
    floorPriceMinor: 40_000,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    id: SEED_SKU_IDS.retinolNightSerum,
    sku: "RETINOL-SERUM-30ML",
    name: "Retinol Night Serum",
    listPriceMinor: 190_000,
    floorPriceMinor: 115_000,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    id: SEED_SKU_IDS.foamingFaceWash,
    sku: "FOAM-FACEWASH-100ML",
    name: "Foaming Face Wash",
    listPriceMinor: 55_000,
    floorPriceMinor: 34_000,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    id: SEED_SKU_IDS.micellarWater,
    sku: "MICELLAR-WATER-200ML",
    name: "Micellar Water Cleanser",
    listPriceMinor: 60_000,
    floorPriceMinor: 37_000,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    id: SEED_SKU_IDS.clayDetoxMask,
    sku: "CLAY-MASK-100G",
    name: "Clay Detox Face Mask",
    listPriceMinor: 75_000,
    floorPriceMinor: 46_000,
    slowMoving: false,
    affinityGroup: "masks",
  },
  {
    id: SEED_SKU_IDS.sheetMaskSet,
    sku: "SHEETMASK-SET-5PK",
    name: "Sheet Mask Set (5-Pack)",
    listPriceMinor: 85_000,
    floorPriceMinor: 52_000,
    slowMoving: false,
    affinityGroup: "masks",
  },
  {
    id: SEED_SKU_IDS.spf50SunscreenGel,
    sku: "SPF50-GEL-50ML",
    name: "SPF 50 Sunscreen Gel",
    listPriceMinor: 95_000,
    floorPriceMinor: 58_000,
    slowMoving: false,
    affinityGroup: "sun-care",
  },
  {
    id: SEED_SKU_IDS.underEyeCream,
    sku: "EYE-CREAM-15ML",
    name: "Under-Eye Cream",
    listPriceMinor: 110_000,
    floorPriceMinor: 65_000,
    slowMoving: true,
    affinityGroup: "moisturizers",
  },
  {
    id: SEED_SKU_IDS.dayMoisturizer,
    sku: "DAY-MOIST-50ML",
    name: "Hydrating Day Moisturizer",
    listPriceMinor: 105_000,
    floorPriceMinor: 63_000,
    slowMoving: false,
    affinityGroup: "moisturizers",
  },
  {
    id: SEED_SKU_IDS.ahaBhaToner,
    sku: "AHA-BHA-TONER-100ML",
    name: "Exfoliating AHA/BHA Toner",
    listPriceMinor: 80_000,
    floorPriceMinor: 49_000,
    slowMoving: false,
    affinityGroup: "toners",
  },
  {
    id: SEED_SKU_IDS.rosewaterMist,
    sku: "ROSE-MIST-100ML",
    name: "Rosewater Facial Mist",
    listPriceMinor: 45_000,
    floorPriceMinor: 28_000,
    slowMoving: false,
    affinityGroup: "toners",
  },
  {
    id: SEED_SKU_IDS.charcoalPeelMask,
    sku: "CHARCOAL-PEEL-75ML",
    name: "Charcoal Peel-Off Mask",
    listPriceMinor: 70_000,
    floorPriceMinor: 43_000,
    slowMoving: false,
    affinityGroup: "masks",
  },
  {
    id: SEED_SKU_IDS.lipSleepingBalm,
    sku: "LIP-SLEEP-BALM-8G",
    name: "Lip Sleeping Balm",
    listPriceMinor: 50_000,
    floorPriceMinor: 31_000,
    slowMoving: false,
    affinityGroup: "lip-care",
  },
  {
    id: SEED_SKU_IDS.bodyButterWhip,
    sku: "BODY-BUTTER-200G",
    name: "Body Butter Whip",
    listPriceMinor: 90_000,
    floorPriceMinor: 55_000,
    slowMoving: false,
    affinityGroup: "body-care",
  },
  {
    id: SEED_SKU_IDS.antiAcneSpotGel,
    sku: "ACNE-SPOT-GEL-15ML",
    name: "Anti-Acne Spot Gel",
    listPriceMinor: 60_000,
    floorPriceMinor: 37_000,
    slowMoving: false,
    affinityGroup: "spot-treatment",
  },
  {
    id: SEED_SKU_IDS.overnightRepairOil,
    sku: "REPAIR-OIL-30ML",
    name: "Overnight Repair Oil",
    listPriceMinor: 170_000,
    floorPriceMinor: 98_000,
    slowMoving: true,
    affinityGroup: "serums",
  },
] as const;

// ---------------------------------------------------------------------------
// Merchant policy — PRD §5.1 MVP defaults, with this ticket's campaign
// budget and per-deal cap.
// ---------------------------------------------------------------------------

const CAMPAIGN_BUDGET_TOTAL_MINOR = 5_000_000; // ₹50,000
const PER_DEAL_CAP_MINOR = 20_000; // ₹200
const CONCESSION_CURVE: number[] = [0.4, 0.7, 1.0];

const MERCHANT_POLICY_FIELDS = {
  negotiationEnabled: true,
  campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
  perDealCapMinor: PER_DEAL_CAP_MINOR,
  maxRounds: 3,
  concessionCurve: CONCESSION_CURVE,
  offerTtlSeconds: 600,
  slowMovingTolerance: 0.03,
  autonomousPaymentExecution: false,
  policyVersion: 1,
};

const SEED_ALLOWED_COMMITMENTS: ReadonlyArray<{
  commitmentType: CommitmentType;
  valueMinor: number;
}> = [
  { commitmentType: "PREPAID", valueMinor: 12_000 }, // ₹120
  { commitmentType: "NON_RETURNABLE", valueMinor: 9_000 }, // ₹90
  { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 6_000 }, // ₹60
];

// ---------------------------------------------------------------------------
// Reference cart fixture — Serum + Cleanser, qty 1 each, at list. This is
// PRD §18.2's "original cart" (list ₹2,500).
//
// Exported as a plain constant rather than a database row: it isn't tied to
// any negotiation session, and `negotiation_sessions.original_basket` (the
// only frozen column shaped like this) only exists once a session is opened
// by Phase 1 code that doesn't exist yet. Every id here is one of the fixed
// SKU ids above, so it always matches whatever this seed just wrote.
// ---------------------------------------------------------------------------

export const REFERENCE_CART: Basket = {
  lines: [
    { skuId: SEED_SKU_IDS.vitaminCSerum, quantity: 1, unitPriceMinor: 180_000 },
    { skuId: SEED_SKU_IDS.gentleCleanser, quantity: 1, unitPriceMinor: 70_000 },
  ],
  commitments: [],
  currency: CURRENCY,
};

// ---------------------------------------------------------------------------
// Seed function — idempotent, transactional. Upserts by natural key; never
// touches a row this script didn't write.
// ---------------------------------------------------------------------------

export async function seedDatabase(database: typeof db = db): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .insert(merchantsTable)
      .values({ id: SEED_MERCHANT_ID, name: SEED_MERCHANT_NAME })
      .onConflictDoUpdate({
        target: merchantsTable.id,
        set: { name: SEED_MERCHANT_NAME },
      });

    await tx
      .insert(merchantPoliciesTable)
      .values({
        id: SEED_MERCHANT_POLICY_ID,
        merchantId: SEED_MERCHANT_ID,
        ...MERCHANT_POLICY_FIELDS,
      })
      .onConflictDoUpdate({
        target: merchantPoliciesTable.id,
        set: MERCHANT_POLICY_FIELDS,
      });

    for (const commitment of SEED_ALLOWED_COMMITMENTS) {
      await tx
        .insert(commitmentValuesTable)
        .values({ merchantId: SEED_MERCHANT_ID, ...commitment })
        .onConflictDoUpdate({
          target: [commitmentValuesTable.merchantId, commitmentValuesTable.commitmentType],
          set: { valueMinor: commitment.valueMinor },
        });
    }

    for (const item of SEED_CATALOGUE) {
      const fields = {
        name: item.name,
        listPriceMinor: item.listPriceMinor,
        floorPriceMinor: item.floorPriceMinor,
        negotiable: true,
        slowMoving: item.slowMoving,
        affinityGroup: item.affinityGroup,
      };

      await tx
        .insert(skuPoliciesTable)
        .values({ id: item.id, merchantId: SEED_MERCHANT_ID, sku: item.sku, ...fields })
        .onConflictDoUpdate({
          target: [skuPoliciesTable.merchantId, skuPoliciesTable.sku],
          set: fields,
        });
    }

    // Drop any sku_policies row this script previously seeded for a SKU that
    // no longer appears in SEED_CATALOGUE (removed, or renamed), so re-runs
    // converge on exactly the current catalogue instead of leaving stale rows.
    await tx.delete(skuPoliciesTable).where(
      and(
        eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID),
        notInArray(
          skuPoliciesTable.sku,
          SEED_CATALOGUE.map((item) => item.sku),
        ),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — `pnpm --filter @repo/database db:seed`.
// Importing this module (e.g. from a test) never runs this; only executing
// the file directly does.
// ---------------------------------------------------------------------------

if (require.main === module) {
  seedDatabase()
    .then(() => {
      console.log(
        `Seeded merchant ${SEED_MERCHANT_ID} ("${SEED_MERCHANT_NAME}") with ${SEED_CATALOGUE.length} SKUs, ` +
          `1 merchant policy, and ${SEED_ALLOWED_COMMITMENTS.length} commitment values.`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
