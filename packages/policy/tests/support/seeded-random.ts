/**
 * A tiny seeded PRNG for tests only (mulberry32). No dependency exists in
 * this repo for property-based testing (no `fast-check` in the lockfile),
 * and the ticket for TICKET-103 is explicit: hand-roll a seeded generator
 * rather than reach for real `Math.random()`, so the *test itself* stays
 * deterministic and reproducible across CI runs. Not exported from the
 * package's public surface — this lives under `tests/support`, not
 * `generation/`, because it is test infrastructure, not product code.
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

/**
 * A syntactically valid v4-shaped UUID (matches the fixed-nibble pattern the
 * repo's own fixtures already use, e.g. "11111111-1111-4111-8111-...") built
 * from the seeded generator, so `z.string().uuid()` fields in randomized
 * fixtures always validate.
 */
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

/** Fisher-Yates shuffle using the seeded generator, returning a new array. */
export function shuffle<T>(rng: SeededRandom, items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
}
