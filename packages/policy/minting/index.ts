/**
 * TICKET-110 — offer minting. Deliberately re-exports `./mint` ONLY.
 *
 * `./signing` (the raw HMAC signer/verifier) is NOT re-exported here on
 * purpose — see `./signing.ts`'s module doc for why, and its limits. The only
 * way anything outside this directory can obtain a signed `Offer` is by
 * calling `mintOffer`.
 */
export * from "./mint";
