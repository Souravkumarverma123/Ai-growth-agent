import { createHmac, timingSafeEqual } from "node:crypto";

import type { Offer } from "../contracts/negotiation";

/**
 * TICKET-110 — engine-only offer signing (PRD §10, CONTRACTS.md §2, §5.1).
 *
 * Pure, no I/O (CONTRACTS.md §2, §8): this module never touches a database or
 * the network. `resolveDefaultSigningSecret` reads `process.env` rather than
 * a socket or a file, the same class of "module-level constant sourced from
 * env" the ticket text explicitly sanctions — not a KMS integration, this is
 * a hackathon.
 *
 * ============================================================================
 * WHY THIS FILE IS NOT RE-EXPORTED FROM `packages/policy/index.ts`
 * ============================================================================
 * TICKET-110's acceptance criterion is "the signing function is not reachable
 * from packages/agent" (B2, CONTRACTS.md §2). `../minting/index.ts` re-exports
 * only `./mint` (the pure `mintOffer` construction/signing entry point) — it
 * deliberately does NOT do `export * from "./signing"`, so `signOfferPayload`
 * and `verifyOfferSignature` never appear on `@repo/policy`'s public barrel.
 * A caller can only ever obtain a signed `Offer` by calling `mintOffer`; nothing
 * on the public surface lets it call the signer directly with an arbitrary
 * payload.
 *
 * This is a structural, convention-level barrier, not an airtight technical
 * one — recorded here openly rather than overstated (the same discipline
 * `ledger/hash-chain.ts` uses for the hash chain's own "self-anchored"
 * limitation, CONTRACTS.md §7). `@repo/policy/package.json` has no `exports`
 * field restricting subpath resolution — nothing in this monorepo's packages
 * do (see e.g. `packages/database/repositories/campaign-holds.ts` importing
 * `@repo/policy/contracts` directly) — so a determined caller could still
 * write `import { signOfferPayload } from "@repo/policy/minting/signing"` and
 * bypass the barrel. Closing that completely would mean adding a package-wide
 * `exports` map to `@repo/policy`, which is a change to every consumer's
 * subpath-import surface (`@repo/policy/contracts`, `@repo/policy/economics`,
 * etc. are all used today by `packages/database`), not a `packages/policy`-only
 * change, so it is out of this ticket's `Affected` scope and not attempted
 * here. See the PR description for the full reasoning.
 */

const SIGNING_SECRET_ENV_VAR = "OFFER_SIGNING_SECRET";

function requireSafeInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`signOfferPayload: ${description} is not a safe integer (${value})`);
  }
  return value;
}

/**
 * The exact authoritative offer fields the signature covers, and in what
 * order — mirrors `ledger/hash-chain.ts`'s `HASHED_FIELDS` discipline: a
 * fixed, explicit field list, deterministic ordering, no floating point.
 * `basket`, `status`, `reasonCode`, `consumedAt` are deliberately NOT signed:
 * they either never change after mint (`basket` is covered indirectly by
 * `totalMinor`/`candidateId` identifying which economics were authorized) or
 * change over the offer's lifecycle in ways this signature must not
 * invalidate (`status`, `consumedAt`).
 */
export type SignableOfferFields = Pick<
  Offer,
  | "offerId"
  | "sessionId"
  | "candidateId"
  | "totalMinor"
  | "currency"
  | "tier"
  | "campaignSpendMinor"
  | "policyVersion"
  | "expiresAt"
>;

const SIGNED_FIELDS = [
  "offerId",
  "sessionId",
  "candidateId",
  "totalMinor",
  "currency",
  "tier",
  "campaignSpendMinor",
  "policyVersion",
  "expiresAt",
] as const satisfies readonly (keyof SignableOfferFields)[];

/**
 * Deterministically renders one field's value as a string. A `Date` becomes
 * its ISO string (never `Date.now()`-sensitive — the date is a field on the
 * signed object, not read fresh), and every money/version field is asserted a
 * safe integer first so a float or precision-lossy value can never silently
 * sign successfully (CONTRACTS.md §3, §6).
 */
function canonicalizeField(field: (typeof SIGNED_FIELDS)[number], value: SignableOfferFields[typeof field]): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(requireSafeInteger(value, field));
  return String(value);
}

function canonicalPayload(fields: SignableOfferFields): string {
  return SIGNED_FIELDS.map((field) => `${field}=${canonicalizeField(field, fields[field])}`).join("|");
}

function resolveDefaultSigningSecret(): string {
  const secret = process.env[SIGNING_SECRET_ENV_VAR];
  if (!secret) {
    throw new Error(
      `signOfferPayload: ${SIGNING_SECRET_ENV_VAR} is not set and no explicit signingSecret was supplied`,
    );
  }
  return secret;
}

/**
 * HMAC-SHA256 over the canonical serialization of `fields`. Deterministic:
 * the same field values and the same secret always produce the same
 * signature. `signingSecret` is a plain input parameter (falling back to a
 * module-level, env-sourced constant when omitted) — no KMS integration.
 */
export function signOfferPayload(fields: SignableOfferFields, signingSecret?: string): string {
  const secret = signingSecret ?? resolveDefaultSigningSecret();
  return createHmac("sha256", secret).update(canonicalPayload(fields), "utf8").digest("hex");
}

/**
 * Recomputes the expected signature from `fields` and compares it to
 * `signature` in constant time (`timingSafeEqual`), so verification cannot
 * leak timing information about how much of a forged signature happened to
 * match.
 */
export function verifyOfferSignature(
  fields: SignableOfferFields,
  signature: string,
  signingSecret?: string,
): boolean {
  const expected = signOfferPayload(fields, signingSecret);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
