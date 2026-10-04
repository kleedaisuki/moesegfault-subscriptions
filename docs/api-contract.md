# Billing and Subscribe contract

Billing is an OAuth resource server, never an authentication service. It accepts only
Identity access tokens from its fixed environment issuer and exact registered
client IDs configured in `BILLING_AUDIENCES` (JSON array). Tokens remain in the
Subscribe BFF; React uses only same-origin BFF endpoints and a host-only session.

## API

All time fields are integer Unix seconds. Authenticated operations use
`Authorization: Bearer <access token>`. Errors are RFC 9457 problem JSON with
`error_code`, `status`, `title`, and correlation header. Profile contact is
self-declared billing information, **not a verified Identity contact**.

| Method / path | Body | Response |
| --- | --- | --- |
| GET `/healthz` | none | `{status:"ok"}` |
| GET `/v1/plans` | none | `{plans: Plan[]}` |
| GET `/v1/me` | none | `{account: BillingAccount, subscriptions: Subscription[]}` |
| PUT `/v1/me/profile` | BillingProfile replacement | `{account: BillingAccount}` |
| POST `/v1/activations` | `{code:string}`, required `Idempotency-Key` header | `{subscription:Subscription,replayed:boolean}` |
| POST `/v1/admin/activation-codes` | `{plan_id:string}`, UUIDv4 `Idempotency-Key` | `{issuance_id:string,status:"pending"\|"sent"\|"unknown"}` |

`Plan`: `id`, `product_id`, `name` and `description` objects keyed by `zh-CN`, `en`,
`ja`, `duration_days`, `active`, `entitlements` string array. The registry is
deployment-owned `PLAN_REGISTRY_JSON`; adding a plan does not require code changes.

`BillingAccount`: `id`, `profile`, `created_at`, `updated_at`.
`BillingProfile`: optional nullable strings `display_name`, `email`, `country`
(ISO 3166 alpha-2), `address_line1`, `address_line2`, `city`, `postal_code`, `tax_id`.
Profile PUT replaces the profile, permitting clearing previously stored information.

`Subscription`: `id`, `product_id`, `plan_id`, `status` (`active` / `expired`),
`current_period_start`, `current_period_end`, `activation_source` (`activation_code`),
`entitlements` string array. One subscription per account/product. A new code extends
from max(current expiration, now), never overwrites remaining time.
While a product subscription is active, only its current plan can be extended.
A different plan returns `409 plan_conflict` and leaves the activation code unused;
switching is allowed after expiry. This prevents inexpensive accumulated lower-tier
time from becoming higher-tier entitlement time without an explicit conversion policy.

Admin authorization is a separate random secret, `BILLING_ADMIN_KEY`; an ordinary
OAuth token never grants issuance. Local tooling reads an ignored private key file
and submits an immutable UUIDv4 issuance intent. The server derives one code with
HMAC-SHA256, stores only its hash, and sends it directly through the `EMAIL` binding
from `subscribe@moesegfault.dev` to the `ADMIN_EMAIL` secret. Codes expire 30 days
after issuance. Neither raw codes nor recipient addresses enter HTTP responses or
logs. A provider send and D1 cannot commit together: durable `unknown` receipts are
never automatically resent. Reconciliation must recover the existing delivery or
explicitly retire its code before a fresh intent; blind retries cannot mint grants.

## Atomicity

D1 stores code SHA-256 hashes only (HMAC-derived high-entropy raw codes). A redemption INSERT,
protected by unique code hash and unique account/idempotency hash, triggers the entire
subscription grant in one database statement. Stored result JSON makes identical
retries deterministic even after later extensions. A different payload using the
same idempotency key is rejected. Concurrent redemption cannot grant twice.

## Account integration

The Account first-party cookie is not accepted by Billing. Account can link to or
display a Subscribe-owned subscription viewer that authenticates through the same
registered BFF; no Identity service extension or email-based account joining.

## References

- [Workers Rust support](https://developers.cloudflare.com/workers/languages/rust/)
- [D1 prepared statements and batching](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [JWT Best Current Practices RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)
- [OAuth Security BCP RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
