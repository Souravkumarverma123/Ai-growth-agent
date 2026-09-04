import { z } from "zod";

/**
 * FROZEN CONTRACT — CONTRACTS.md §3.
 *
 * Every monetary value in this system is an integer in minor units (paise).
 * No floats, no decimals, no strings, at any layer. Formatting to rupees
 * happens only at the React render boundary.
 */
export type MinorUnits = number;

export const CURRENCY = "INR" as const;
export type Currency = typeof CURRENCY;

/** Money that can never be negative: prices, floors, totals, budgets. */
export const minorUnitsSchema = z
  .number()
  .int("money must be an integer in minor units (paise)")
  .nonnegative()
  .describe("Amount in minor units (paise)");

/**
 * Money that may be negative: a contribution delta, which is negative exactly
 * when a proposed basket is dilutive.
 */
export const signedMinorUnitsSchema = z
  .number()
  .int("money must be an integer in minor units (paise)")
  .describe("Signed amount in minor units (paise)");

export const currencySchema = z.literal(CURRENCY);

/**
 * Fractions — the concession curve and the slow-moving tolerance — are always
 * expressed in [0, 1]. Never integers-as-percent: 0.03, not 3.
 */
export const fractionSchema = z.number().min(0).max(1);
