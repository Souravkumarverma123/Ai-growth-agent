# @repo/services

Empty by design.

The Google OAuth user service that shipped with the starter template was removed
(see `issue-tracker.md`, ISSUE-001): it made three `GOOGLE_OAUTH_*` environment
variables a hard requirement for booting the API, and this product does not use
it.

The package is kept as the service-layer placeholder named in `CONTRACTS.md` §2.
Business logic for the Merchant Growth Agent lives in `@repo/policy`,
`@repo/agent` and `@repo/payments`, which have boundary rules the service layer
does not.
