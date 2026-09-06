import { describe, expect, it } from "vitest";

import type { Basket, CommitmentType, Offer } from "../contracts";
import { COMMITMENT_TYPES } from "../contracts";
import { evaluateOfferAcceptance } from "../acceptance";
import { createSeededRandom, randomInt, randomUuid, shuffle } from "./support/seeded-random";

/**
 * TICKET-602 — the offer-lifecycle-and-idempotency invariant suite, pure half
 * (PRD §10.2, §11, §21; Settled by Q13).
 *
 * The four assertions this ticket names —
 *
 *   1. one offer cannot create multiple orders, including under concurrency
 *   2. an expired offer cannot be consumed
 *   3. a consumed offer cannot be consumed again
 *   4. a basket altered between mint and accept is refused
 *
 * — split cleanly across the two packages the ticket lists as `Affected`.
 * Invariant 1, and the *transactional* enforcement of 2/3/4 (consume exactly
 * once, under a race), are database-level guarantees and are proven against a
 * real Postgres in `packages/payments/tests/invariants-offer-lifecycle.test.ts`
 * (CONTRACTS.md §8 — "do not mock the database").
 *
 * This file owns the other half: the pure accept-time *rule* that decides
 * whether a single accept attempt is allowed, and which of the three closed
 * reason codes applies when it is not. `evaluateOfferAcceptance`
 * (`acceptance/acceptance.ts`, TICKET-111) is pure (CONTRACTS.md §2, §8 —
 * "call it directly"), so there is no seam and no database here. What this
 * suite adds over `offer-acceptance.test.ts`'s hand-picked cases is
 * randomized coverage: the invariants must hold as emergent properties over
 * arbitrary offers, baskets and clocks, not just the fixtures someone
 * thought to write down.
 *
 * All money is integer minor units (paise) throughout (CONTRACTS.md §3).
 *
 * ---------------------------------------------------------------------------
 * WHY THE PURE LAYER IS NOT THE IDEMPOTENCY GUARANTEE
 * ---------------------------------------------------------------------------
 * `evaluateOfferAcceptance` reads a snapshot handed to it — it never writes.
 * Two concurrent callers can both be handed `consumedAt: null` and both get
 * `{ accepted: true }`; the "consumed exactly once" guarantee is the atomic
 * compare-and-set in `packages/database/repositories/offers.ts` (a single
 * `UPDATE ... WHERE consumed_at IS NULL`), exercised under a real race in the
 * payments-side file. The last describe block below pins that division of
 * responsibility: this layer only reads the snapshot it is handed, and eight
 * callers handed the same unconsumed snapshot all "succeed".
 */

type Rng = ReturnType<typeof createSeededRandom>;

const MINT_TIME = new Date("2026-06-01T12:00:00.000Z");
const OFFER_TTL_SECONDS = 600; // PRD §10
const EXPIRES_AT = new Date(MINT_TIME.getTime() + OFFER_TTL_SECONDS * 1000);

/** A random, schema-shaped basket: 1–4 lines, 0–3 distinct commitments. */
function randomBasket(rng: Rng): Basket {
  const lineCount = randomInt(rng, 1, 4);
  const commitmentCount = randomInt(rng, 0, COMMITMENT_TYPES.length);
  const commitments = shuffle(rng, [...COMMITMENT_TYPES]).slice(0, commitmentCount);
  return {
    currency: "INR",
    commitments,
    lines: Array.from({ length: lineCount }, () => ({
      skuId: randomUuid(rng),
      quantity: randomInt(rng, 1, 5),
      unitPriceMinor: randomInt(rng, 1_000, 500_000),
    })),
  };
}

/** A structurally independent deep copy — the buyer reconstructing "the same basket". */
function cloneBasket(basket: Basket): Basket {
  return {
    currency: basket.currency,
    commitments: [...basket.commitments],
    lines: basket.lines.map((line) => ({ ...line })),
  };
}

type OfferSnapshot = Pick<Offer, "expiresAt" | "consumedAt" | "basket">;

function snapshot(overrides: Partial<OfferSnapshot> = {}): OfferSnapshot {
  return { expiresAt: EXPIRES_AT, consumedAt: null, basket: randomBasket(createSeededRandom(1)), ...overrides };
}

// ===========================================================================
// Invariant 2 — an expired offer cannot be consumed
// ===========================================================================

describe("INVARIANT: an expired offer is never accepted, whatever else is true about it (PRD §10.2, §21.10)", () => {
  it("holds across 300 randomized offers and post-expiry clocks", () => {
    const rng = createSeededRandom(0x602_0002);

    for (let trial = 0; trial < 300; trial += 1) {
      const basket = randomBasket(rng);
      // Anywhere from 1 ms to ~2 days past the expiry instant.
      const now = new Date(EXPIRES_AT.getTime() + randomInt(rng, 1, 172_800_000));
      // Independently: sometimes also already consumed, sometimes a mismatched
      // basket — expiry must still win, every time.
      const alreadyConsumed = rng() > 0.5;
      const acceptedBasket = rng() > 0.5 ? cloneBasket(basket) : randomBasket(rng);

      const result = evaluateOfferAcceptance({
        offer: {
          expiresAt: EXPIRES_AT,
          consumedAt: alreadyConsumed ? new Date(MINT_TIME.getTime() + 1_000) : null,
          basket,
        },
        acceptedBasket,
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    }
  });

  it("the boundary is inclusive: accepted at exactly expiresAt, refused one millisecond later", () => {
    const base = snapshot({ basket: randomBasket(createSeededRandom(7)) });
    const acceptedBasket = cloneBasket(base.basket);

    expect(evaluateOfferAcceptance({ offer: base, acceptedBasket, now: EXPIRES_AT })).toEqual({
      accepted: true,
    });
    expect(
      evaluateOfferAcceptance({
        offer: base,
        acceptedBasket,
        now: new Date(EXPIRES_AT.getTime() + 1),
      }),
    ).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
  });
});

// ===========================================================================
// Invariant 3 — a consumed offer cannot be consumed again
// ===========================================================================

describe("INVARIANT: an offer with consumedAt already set is never accepted again (PRD §10.2, §21.10)", () => {
  it("holds across 300 randomized offers, consumption instants and accept baskets", () => {
    const rng = createSeededRandom(0x602_0003);

    for (let trial = 0; trial < 300; trial += 1) {
      const basket = randomBasket(rng);
      // Consumed at some instant strictly inside the TTL window.
      const consumedAt = new Date(
        MINT_TIME.getTime() + randomInt(rng, 1, OFFER_TTL_SECONDS * 1000 - 10_000),
      );
      // The replay attempt lands after that, but still inside the TTL — so
      // OFFER_EXPIRED cannot be what's masking the result.
      const now = new Date(consumedAt.getTime() + randomInt(rng, 1, 5_000));
      expect(now.getTime()).toBeLessThanOrEqual(EXPIRES_AT.getTime());

      const acceptedBasket = rng() > 0.5 ? cloneBasket(basket) : randomBasket(rng);

      const result = evaluateOfferAcceptance({
        offer: { expiresAt: EXPIRES_AT, consumedAt, basket },
        acceptedBasket,
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
    }
  });

  it("an offer accepted once, then replayed with the identical basket, is refused the second time", () => {
    const basket = randomBasket(createSeededRandom(11));
    const acceptedBasket = cloneBasket(basket);
    const now = new Date(MINT_TIME.getTime() + 60_000);

    const first = evaluateOfferAcceptance({
      offer: { expiresAt: EXPIRES_AT, consumedAt: null, basket },
      acceptedBasket,
      now,
    });
    expect(first).toEqual({ accepted: true });

    // The database CAS would have stamped consumedAt here; the pure rule then
    // refuses any further attempt that carries that stamp.
    const replay = evaluateOfferAcceptance({
      offer: { expiresAt: EXPIRES_AT, consumedAt: now, basket },
      acceptedBasket,
      now: new Date(now.getTime() + 1),
    });
    expect(replay).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
  });
});

// ===========================================================================
// Invariant 4 — a basket altered between mint and accept is refused
// ===========================================================================

describe("INVARIANT: any deviation between the minted basket and the accepted basket is refused (PRD §10.2, §21.10)", () => {
  const rng = createSeededRandom(0x602_0004);

  /** Every single-field mutation PRD §10.2 names as "the accepted basket differs". */
  const mutators: ReadonlyArray<{ name: string; mutate: (b: Basket) => Basket }> = [
    {
      name: "a changed SKU on the first line",
      mutate: (b) => ({
        ...b,
        lines: b.lines.map((line, i) => (i === 0 ? { ...line, skuId: randomUuid(rng) } : line)),
      }),
    },
    {
      name: "a changed quantity on the first line",
      mutate: (b) => ({
        ...b,
        lines: b.lines.map((line, i) => (i === 0 ? { ...line, quantity: line.quantity + 1 } : line)),
      }),
    },
    {
      name: "a one-paise change to a unit price",
      mutate: (b) => ({
        ...b,
        lines: b.lines.map((line, i) =>
          i === 0 ? { ...line, unitPriceMinor: line.unitPriceMinor + 1 } : line,
        ),
      }),
    },
    {
      name: "an extra line appended",
      mutate: (b) => ({
        ...b,
        lines: [...b.lines, { skuId: randomUuid(rng), quantity: 1, unitPriceMinor: 10_000 }],
      }),
    },
    {
      name: "a line dropped",
      mutate: (b) => ({ ...b, lines: b.lines.slice(0, -1) }),
    },
    {
      name: "the line order reversed",
      mutate: (b) => ({ ...b, lines: [...b.lines].reverse() }),
    },
    {
      name: "an added commitment",
      mutate: (b) => {
        const missing = COMMITMENT_TYPES.filter(
          (c) => !b.commitments.includes(c),
        ) as CommitmentType[];
        return { ...b, commitments: [...b.commitments, missing[0] ?? "PREPAID"] };
      },
    },
    {
      name: "a dropped commitment",
      mutate: (b) => ({ ...b, commitments: b.commitments.slice(0, -1) }),
    },
    {
      name: "a changed currency",
      mutate: (b) => ({ ...b, currency: "USD" as Basket["currency"] }),
    },
  ];

  for (const { name, mutate } of mutators) {
    it(`refuses ${name} — over 40 randomized minted baskets`, () => {
      let exercised = 0;
      for (let trial = 0; trial < 40; trial += 1) {
        const minted = randomBasket(rng);
        const mutated = mutate(cloneBasket(minted));

        // Some mutators are no-ops on some random baskets (dropping a
        // commitment when there are none; reversing a single-line basket) —
        // skip those, they aren't "a difference".
        if (JSON.stringify(mutated) === JSON.stringify(minted)) continue;
        // basketSchema requires >= 1 line; "a line dropped" can violate that,
        // which is a different (schema) failure, not BASKET_MISMATCH.
        if (mutated.lines.length === 0) continue;
        exercised += 1;

        const result = evaluateOfferAcceptance({
          offer: { expiresAt: EXPIRES_AT, consumedAt: null, basket: minted },
          acceptedBasket: mutated,
          now: MINT_TIME,
        });
        expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
      }
      expect(exercised).toBeGreaterThan(0);
    });
  }

  it("accepts when the buyer reconstructs the exact same basket independently (200 randomized baskets)", () => {
    const localRng = createSeededRandom(0x602_0044);
    for (let trial = 0; trial < 200; trial += 1) {
      const minted = randomBasket(localRng);
      const result = evaluateOfferAcceptance({
        offer: { expiresAt: EXPIRES_AT, consumedAt: null, basket: minted },
        acceptedBasket: cloneBasket(minted),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: true });
    }
  });

  it("treats the commitment set as unordered — a reordered commitment list is not a mismatch", () => {
    const localRng = createSeededRandom(0x602_0045);
    for (let trial = 0; trial < 60; trial += 1) {
      const minted = randomBasket(localRng);
      if (minted.commitments.length < 2) continue;
      const reordered: Basket = {
        ...cloneBasket(minted),
        commitments: shuffle(localRng, [...minted.commitments]),
      };
      const result = evaluateOfferAcceptance({
        offer: { expiresAt: EXPIRES_AT, consumedAt: null, basket: minted },
        acceptedBasket: reordered,
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: true });
    }
  });
});

// ===========================================================================
// Precedence — the three refusals are checked expiry, then consumed, then
// basket, and that order never drifts under randomization.
// ===========================================================================

describe("INVARIANT: refusal precedence is fixed — expiry, then already-consumed, then basket (acceptance.ts module doc)", () => {
  it("an offer that is expired AND consumed AND basket-mismatched reads as OFFER_EXPIRED, 100 times", () => {
    const rng = createSeededRandom(0x602_00ee);
    for (let trial = 0; trial < 100; trial += 1) {
      const minted = randomBasket(rng);
      const result = evaluateOfferAcceptance({
        offer: {
          expiresAt: EXPIRES_AT,
          consumedAt: new Date(MINT_TIME.getTime() + 1_000),
          basket: minted,
        },
        acceptedBasket: randomBasket(rng),
        now: new Date(EXPIRES_AT.getTime() + randomInt(rng, 1, 10_000)),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    }
  });

  it("an offer that is consumed AND basket-mismatched (but not expired) reads as OFFER_ALREADY_CONSUMED, 100 times", () => {
    const rng = createSeededRandom(0x602_00ef);
    for (let trial = 0; trial < 100; trial += 1) {
      const minted = randomBasket(rng);
      const result = evaluateOfferAcceptance({
        offer: {
          expiresAt: EXPIRES_AT,
          consumedAt: new Date(MINT_TIME.getTime() + 1_000),
          basket: minted,
        },
        acceptedBasket: {
          ...cloneBasket(minted),
          lines: minted.lines.map((l, i) => (i === 0 ? { ...l, quantity: l.quantity + 1 } : l)),
        },
        now: new Date(MINT_TIME.getTime() + randomInt(rng, 2_000, 100_000)),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
    }
  });
});

// ===========================================================================
// The pure layer is a rule, not the idempotency guarantee.
// ===========================================================================

describe("INVARIANT: the acceptance module supplies a decision rule only — never a mutation path", () => {
  it("is a pure function of its arguments — same input yields the same result, with no observable effect on the offer it was handed", () => {
    const basket = randomBasket(createSeededRandom(0x602_0f0f));
    const offer = { expiresAt: EXPIRES_AT, consumedAt: null, basket };
    const frozenSnapshot = JSON.stringify(offer);
    const a = evaluateOfferAcceptance({ offer, acceptedBasket: cloneBasket(basket), now: MINT_TIME });
    const b = evaluateOfferAcceptance({ offer, acceptedBasket: cloneBasket(basket), now: MINT_TIME });
    expect(a).toEqual(b);
    expect(a).toEqual({ accepted: true });
    // The offer it read is untouched — no consumedAt stamped, nothing marked.
    // The exactly-once guarantee is the database's CAS, exercised under a real
    // race in the payments-side file; this layer only ever reads a snapshot.
    expect(JSON.stringify(offer)).toBe(frozenSnapshot);
  });

  it("two callers handed the same unconsumed snapshot both get accepted — the race is the database's to resolve, not this function's", () => {
    const basket = randomBasket(createSeededRandom(0x602_0f1f));
    const offer = { expiresAt: EXPIRES_AT, consumedAt: null, basket };
    const now = new Date(MINT_TIME.getTime() + 1_000);

    const results = Array.from({ length: 8 }, () =>
      evaluateOfferAcceptance({ offer, acceptedBasket: cloneBasket(basket), now }),
    );
    // All eight "succeed" here — proving the pure rule cannot be the
    // exactly-once guarantee, which is why the payments-side file drives the
    // real Postgres CAS under a genuine race.
    expect(results.every((r) => r.accepted)).toBe(true);
  });
});
