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

These URLs are deployment targets, not a claim that every acceptance step has
already passed. See the delivery record for actual verification.

## Integration

- Start with [the API contract](docs/api-contract.md) and the progressive-disclosure
  integration instructions in [`skills/`](skills/).
- Frontends enter Subscribe through its registered login flow. OAuth tokens and
  private client keys never enter browser storage or application URLs.
- Consumer services validate the fixed Identity issuer and their exact configured
  registered client audience. Billing accounts are keyed by `(issuer, sub)`.
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
Keep the original issuance intent when recovering an uncertain result.

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
without rebuilding. Manually select `staging-only` in the staging delivery
workflow to deploy a candidate. No production promotion is included.

Cloudflare deployment secrets remain in GitHub and Workers; public registration
metadata lives in `infra/`. Identity staging OAuth-client registration follows its
existing audited migration mechanism, with no Identity service implementation
changes. See [delivery ownership and acceptance](docs/delivery-plan.md).

## Account integration boundary

Account uses a first-party Identity cookie, while Subscribe uses an OIDC application
session. Identity's pairwise OIDC subject cannot be equated to Account's internal
principal identifier. The Account section embeds the Subscribe-owned viewer and
provides an explicit top-level sign-in/reconnect action. Verify the account shown
by that viewer when changing users. Never join subscriptions by editable email or
forward Identity cookies into Billing.

## License

GPL-3.0-only; see [LICENSE](LICENSE). Vendored platform design assets retain their
own license and version attribution.
