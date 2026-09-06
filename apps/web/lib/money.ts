/**
 * The one place minor units (paise) become a human-readable rupee string.
 * CONTRACTS.md: "Formatting to rupees happens only at the React render
 * boundary." Every amount that crosses the wire — offer totals, the payment
 * handle amount, basket line prices — is an integer in minor units; nothing
 * in this app does arithmetic on the rupee value.
 */
export function formatRupees(minor: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(minor / 100);
}
