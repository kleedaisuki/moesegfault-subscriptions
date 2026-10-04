# Billing consumer integration

## Caller model

Use Identity's confidential web-client / BFF integration for browser applications. Read the Identity skill's application onboarding and OIDC integration references for client registration and token lifecycle. Billing does not collect passwords and does not call Login as a token validation API.

Pin the environment's issuer and exact accepted OAuth client audience. Identity currently sets access-token audience to the registered client ID; do not assume a generic resource audience exists. Require the registered scope and validate signature, approved algorithm, key metadata, issuer, audience, token kind, and validity interval before looking up the BillingAccount.

## Domain boundaries

- BillingAccount belongs to the verified principal and stores a billing profile, not an authentication account.
- Billing profile contact and address fields are user-editable invoicing metadata; they do not prove legal identity or ownership of an authentication email.
- Subscription grants are product-scoped. Check the active period and the granted entitlements, rather than inferring access from a plan display name.
- Activation preserves a snapshot of the registered product, period, and entitlements. New catalog entries and edits must not silently rewrite previously issued capabilities.

## Retry and errors

Keep one idempotency key per logical activation. Preserve the exact original request after timeout, including the intended principal. Concurrent redemptions must be arbitrated by the database, not a preflight availability read. A repeated successful activation returns the same result without extending the subscription a second time.

Pass machine error codes to application policy; localize user-visible copy at the frontend. Do not render provider details, tokens, or raw response dumps.
