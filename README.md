# moeSegFault Subscriptions

Rust Cloudflare Workers for Billing and Subscribe, with a TypeScript/React
subscription frontend. Identity performs authentication; Billing verifies access
tokens and owns billing accounts, profiles, subscriptions, and activation grants.

## Staging surfaces

| Surface | URL | Responsibility |
| --- | --- | --- |
| Billing | https://billing-staging.moesegfault.dev | Validated bearer-token business API |
| Subscribe | https://subscribe-staging.moesegfault.dev | OIDC BFF, profile, activation, subscription status |
| Account section | https://account-staging.moesegfault.dev/subscriptions | Dedicated authenticated subscription viewer integration |

This release is staging-only; production has not been deployed. See the
[staging acceptance report](docs/validation/staging-e2e-2026-10-05.md) for the
completed browser, registration, profile, activation, and Account checks.

## Integration

- Start with [the API contract](docs/api-contract.md) and the progressive-disclosure
  integration instructions in [`skills/`](skills/).
- Frontends enter Subscribe through its registered login flow. OAuth tokens and
  private client keys never enter browser storage or application URLs.
- Consumer services validate the fixed Identity issuer and their exact configured
  registered client audience. Billing accounts are keyed by `(issuer, sub)`.
  Independently registered clients need a deliberately shared per-environment
  billing subject sector to read the same grants; adding an audience does not join
  accounts. See [consumer onboarding](skills/moesegfault-billing/references/consumers.md).
- Billing profile contact fields are self-declared invoice/profile data, not verified
  Identity contacts. No payment processor or recurring charge is enabled.
- Plans are deployment-owned `PLAN_REGISTRY_JSON` records. Register a stable plan
  and product identifier plus localized metadata, duration, and entitlements; do
  not change identifiers to rename a displayed plan.
- Codes are single-use grants. Redemption is atomic and idempotent; extending an
  existing compatible subscription preserves its remaining time.

## Local administrator workflow

See [administrator operations](docs/admin-operations.md) for setup and recovery.
The local script reads its ignored `.secrets/billing-admin-key` automatically.
The value is never printed. Issuance sends codes from `subscribe@moesegfault.dev`
to the configured `ADMIN_EMAIL` Worker secret, not to a request-supplied address.
`ADMIN_EMAIL` is an independently replaceable secret; recipient values belong in
private environment configuration, not source or documentation. Keep the original issuance intent when recovering an
uncertain result.

```sh
# Create once; the command never displays or silently rotates the key.
node scripts/admin-key.mjs --init
# After private provisioning, issue the current staging plan.
node scripts/admin-issue.mjs --plan platform-monthly
# Recover the same request, not a newly generated code.
node scripts/admin-issue.mjs --resume ORIGINAL_UUID
```

## Register a staging plan

Edit the readable catalog `infra/plans.staging.json`, retaining stable plan/product
IDs and providing Chinese, English, and Japanese metadata.

```sh
npm run plans:sync
npm run plans:check
```

Commit both the catalog and synchronized `wrangler.billing.jsonc`. GitHub Actions
checks their agreement and deploys the reviewed configuration with the staging
release. Existing issued codes retain their grant snapshot. See
[plan operations](skills/moesegfault-billing/references/plans.md).

## Development and deployment

Node 24+, npm 11+, and Rust 1.88 are pinned by the workspace tooling. Generated
builds, dependency trees, experiments, local Workers state, and credentials are
ignored. Keep experiments under root `.cache` or `.temp`.

```sh
npm ci --ignore-scripts --no-fund --no-audit
npm run typecheck
npm test
npm run test:deployment
npm run build
cargo fmt --all -- --check
```

GitHub Actions builds Rust/Wasm once, tests the relevant domain/frontend/storage
contracts, caches Cargo/npm/tooling, and deploys a checksummed immutable package
without rebuilding. Main pushes deploy staging; manually select `staging-only`
in the staging delivery workflow to deploy a candidate. No production promotion
is included.

Cloudflare deployment secrets remain in GitHub and Workers; public registration
metadata lives in `infra/`. Identity staging OAuth-client registration uses its
existing audited migration mechanism. Separately, the user-approved Identity
registration-binding / OAuth-continuation service bug fix is deployed as staging
candidate `7b173e2`; this does not imply a production Identity release. See the
[staging acceptance report](docs/validation/staging-e2e-2026-10-05.md) for the
integrated result and [delivery ownership](docs/delivery-plan.md) for boundaries.

## Account integration boundary

Account uses a first-party Identity cookie, while Subscribe uses an OIDC application
session. Identity's pairwise OIDC subject cannot be equated to Account's internal
principal identifier. The Account section embeds the Subscribe-owned viewer and
provides an explicit top-level sign-in/reconnect action. Verify the account shown
by that viewer when changing users. Never join subscriptions by editable email or
forward Identity cookies into Billing.

Registration has a 30-minute preauthentication window. This is not an authenticated
session lifetime: Identity access tokens last 300 seconds, Subscribe sessions cannot
outlive their token, and this release does not request refresh tokens. After expiry,
the viewer clears protected content and offers sign-in again through Identity SSO.

## License

GPL-3.0-only; see [LICENSE](LICENSE). Vendored platform design assets retain their
own license and version attribution.
