/**
 * A tiny seeded PRNG (mulberry32), the same one
 * `packages/policy/tests/support/seeded-random.ts` and
 * `packages/agent/tests/support/seeded-random.ts` use. It lives in this
 * package's SOURCE tree (not under `tests/`) on purpose: the buyer agent
 * harness (TICKET-206) needs a deterministic generator so that a given
 * `(constraints, seed)` pair always produces the identical negotiation —
 * "two seeded runs produce the two documented outcomes" is a stated
 * acceptance criterion, not a test-only concern.
 *
 * No `fast-check` (or any PRNG dependency) exists in this repo's lockfile, so
 * this is hand-rolled rather than pulled in.
 */
export type SeededRandom = () => number;

/** Returns a function producing numbers in [0, 1), deterministic for a given seed. */
export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  return function seededRandom(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max], inclusive. */
export function randomInt(rng: SeededRandom, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Random element of a non-empty array. */
export function randomChoice<T>(rng: SeededRandom, items: readonly T[]): T {
  const item = items[randomInt(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error("randomChoice: items must be non-empty");
  }
  return item;
}

function randomHex(rng: SeededRandom, length: number): string {
  let hex = "";
  for (let i = 0; i < length; i += 1) {
    hex += Math.floor(rng() * 16).toString(16);
  }
  return hex;
}

/** A syntactically valid v4-shaped UUID built from the seeded generator. */
export function randomUuid(rng: SeededRandom): string {
  const variantNibble = randomChoice(rng, ["8", "9", "a", "b"]);
  return [
    randomHex(rng, 8),
    randomHex(rng, 4),
    `4${randomHex(rng, 3)}`,
    `${variantNibble}${randomHex(rng, 3)}`,
    randomHex(rng, 12),
  ].join("-");
}
