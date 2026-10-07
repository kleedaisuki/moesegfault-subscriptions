# Staging delivery and platform decisions

## Targets and authority

The initial acceptance release is **staging only**. No production environment or
implicit production Wrangler selector exists in this repository. Billing and
Subscribe are independent pure-Rust Workers; Subscribe additionally serves React
assets through the platform's static-assets binding.

| Resource | Pinned staging value |
| --- | --- |
| Billing Worker/domain | `moesegfault-billing-staging` / `billing-staging.moesegfault.dev` |
| Billing D1 | `47022fe7-0e14-4bbb-a52a-c59358b938b1` |
| Subscribe Worker/domain | `moesegfault-subscribe-staging` / `subscribe-staging.moesegfault.dev` |
| Subscribe D1 | `8c2435df-3dcd-4bc8-a6ee-9798fa150a96` |
| Identity issuer | `https://identity-staging.moesegfault.dev` |
| OIDC confidential client | `subscribe-staging` |
| Sender | `subscribe@moesegfault.dev` |

Wrangler configs pin bindings, domains, audiences, and the plan catalog. Creating a
new plan means editing `infra/plans.staging.json` with a stable plan/product ID and
the three localized names/descriptions, running `npm run plans:sync`, then
committing the catalog plus generated `PLAN_REGISTRY_JSON` variable and releasing
Billing. `npm run plans:check` and deployment tests reject an unsynchronized
catalog; the sync tool checks the same stable IDs, three locales, bounded duration
and entitlement identifiers as Rust's registry parser. Rust remains the runtime
authority. Never change the
meaning of an existing plan ID to reinterpret previously granted subscriptions.
Adding arbitrary new request origins to Identity is not required for an OAuth
redirect client.

## Efficient release graph

```text
Rust tests + two sequential WASM builds ─┐
                                      ├─ Wrangler dry-runs ─ checksummed archive
React types + unit tests + assets ──────┘                    │
                                  staging secrets + D1 ── deploy ── smoke
```

The GitHub Actions workflow caches Cargo registry/target/tool binaries by exact
Rust/tool version and Cargo lock hash; npm's download cache is keyed by the npm
lockfile. It does not cache `node_modules`. Builds are hosted, with two Cargo
threads and bounded job deadlines; no local repeated Rust release builds are
needed. The package job downloads both independent outputs, verifies Wrangler
packaging, and uploads one immutable archive with SHA-256 and source revision.
Deployment downloads that archive and never recompiles. Untrusted pull requests
receive no deployment secrets. The credentialed job disables dependency-cache
restore and serializes the staging environment. Main pushes build, verify, and
deploy **staging only**; a candidate branch may use manual `staging-only` dispatch,
while `verify-only` dispatch and pull requests never deploy. No production job or
configuration exists, and an initial main push needs no skip-CI exception or
duplicate bootstrap dispatch.

Post-release smoke retries initial DNS/edge propagation for at most 90 seconds
per endpoint. Rust's hosted job deadline is 15 minutes (first cold run completed
in 5 minutes 15 seconds); frontend is 10 minutes, package/deploy are 8 each.

`worker-build` is pinned to 0.8.6, matching `worker` 0.8.6. Its upstream release
explicitly pins `cargo-platform` for Rust 1.88 compatibility. The neighboring
Identity service successfully uses worker-build 0.8.5, but there is no reason to
carry a mismatched tool version into this new project. Local tool installation is
not required; the initial hosted installation is cached for subsequent builds.
[workers-rs v0.8.6 release](https://github.com/cloudflare/workers-rs/releases/tag/v0.8.6)

Repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already
configured. Only their names were inspected. Use a dedicated least-privilege token
for Workers Scripts Write, D1 Edit and the domain binding scope required by
Wrangler custom-domain routes; no R2 credentials are required. A
`cloudflare-staging` environment can add approval policy without changing code.

## Initial key and client setup

1. `node scripts/admin-key.mjs --init` creates or reuses the ignored administrator
   credential with exclusive OS-user access. It never prints the key.
2. `node scripts/deployment-oidc-client.mjs` creates/reuses the ignored RSA JWK and
   exports only the public `infra/subscribe-staging-client.json` manifest.
3. Store the configurable recipient in ignored `.secrets/admin-email`.
4. `node scripts/deployment-secrets.mjs` pipes local secret values directly to
   Wrangler; it suppresses child output and reports names/status only.
5. Register the public client through Identity's existing reviewed,
   create-only generator and staging migration overlay. This modifies deployment
   metadata, **not** the Identity service implementation. Root approval of the
   specific public SQL is required before applying remotely.

The administrator key grants code issuance only. It is never included in Actions
artifacts, client metadata, static frontend bundles, request URLs, logs, or chat.
Application billing contact data is not an authentication claim.

## Operating commands

```powershell
# Build/test/package on GitHub, then deploy using existing repository secrets.
gh workflow run ci.yml --ref <candidate-branch> -f delivery=staging-only

# Deploy a downloaded, checksum-verified artifact with local Wrangler auth if needed.
# This is a recovery path, not a second build pipeline.
npm run deploy:staging
npm run smoke:staging
```

Apply forward-only D1 migrations before the corresponding Worker. A Worker rollback
does not roll back database content. Preserve old external API contracts and use
additive schema changes for future releases. Billing's health, anonymous rejection,
Subscribe HTML and guest session projection are bounded smoke checks; they do not
replace the required real browser registration → email receipt → profile →
activation → subscription reload acceptance journey.

## Sources and interpretation

- [Cloudflare Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)
  supports workers-rs and `worker-build`; the JS shim is generated platform glue,
  not application backend code.
- [Static-assets SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
  supports an assets binding and worker-first execution. All requests reach Rust,
  which handles explicit APIs and delegates only asset routes to `ASSETS`; this
  unifies environment-paired framing policy and preserves asset Cache-Control
  without accidentally returning SPA HTML for API and health endpoints.
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
  provide ordered migration history; application deployment remains separate.
- [GitHub setup-node](https://github.com/actions/setup-node#caching-global-packages-data)
  caches package-manager global data rather than dependency trees.
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
  scope release approvals and secret availability.
- [Empirical CI/CD cache study, 2026](https://arxiv.org/abs/2604.13129)
  examines 952 repositories. It is an emerging preprint, not a deployment authority;
  its useful design implication is to make cache keys and observed cold/warm times
  explicit rather than treating caching as automatically effective. Record actual
  first and subsequent hosted build durations after rollout; tune only the
  measured critical path.

## amail v0.2.0 staging authorization bridge

The candidate adds Billing migrations 0003/0004, staged amail plan catalog, and the
Subscribe hosted route `/amail/authorize/{opaque_handle}`. It does not change
Identity registrations, the existing amail subject sector, or production resources.

Before deploying, provision the same random dedicated credential in:

- subscriptions GitHub environment `cloudflare-staging`: `AMAIL_SERVICE_KEY`;
- amail staging environment: `BILLING_SERVICE_KEY`.

The repository-local ignored source is `.secrets/amail-service.staging.key`.
Never print its contents. `node scripts/deployment-amail-secret.mjs` provisions only
staging Billing, with stdin transport and suppressed child/disk logs; the staging
CI release runs the same helper with its environment secret. Production does not
receive this secret or change catalog/consent policy automatically.

Approval is a real authenticated human action, and paid grants require an actual
activation code. Usage events accrue immutable liabilities with `pending_settlement`;
there is no payment-provider or recurring debit integration. The API and user UI
must preserve this distinction. See `amail-hosted-authorization.md` and
`amail-usage-ledger.md` for exact boundaries and local acceptance evidence.

### HTTP trace retention boundary

Billing and Subscribe HTTP producer Cloudflare Logs and native Traces are disabled
on staging. Query-string redaction alone cannot protect opaque authorization IDs in
paths from provider log wrappers. Closed spans therefore persist directly in the
respective D1 databases; no HTTP console logger or raw request context is retained.
Rows have a seven-day logical retention target; every insert performs bounded
128-row expiry cleanup, and reads exclude expired rows even when idle cleanup lags.
Span insertion failure is best effort and cannot change a committed business response.

Both services expose the fixed, machine-only `POST /v1/service/amail/trace-query`
with `Authorization: Bearer <AMAIL_SERVICE_KEY>` and JSON `{trace_id}`. Responses are
`{schema_version:1,spans:[...]}`, with the closed 12-field envelope and at most 128
rows; query requests do not create trace storage recursively. No arbitrary filters,
URLs, account identifiers, raw provider metadata, or browser-readable key is accepted.
The staging provisioning helper now installs the same key on Billing and Subscribe.
Binding `updated_at` is a strictly monotonic authority timestamp (may increment by
one for same-second approvals), while `approved_at` retains actual UTC consent time.

## Explicit independent Issues-off intent and authoritative readback

The staging configuration now explicitly sets `observability.issues.enabled:false`
for Billing and Subscribe, in addition to Logs and Traces off. Pinned Wrangler
4.147.0's schema and actual `unstable_readConfig` accept and preserve the field.
Global `observability.enabled:false` is not used as proof of independent Issues
capture state. Production configuration is unchanged.

The 3e2c4e8 staging code was observed serving Billing version
`93fb7a25-3b2b-4643-acb9-f0cfdbdb5dca` and Subscribe version
`92fae69f-65a4-443a-a4f8-7d482611de7c`, both at 100%. Version metadata omitted
capture settings, so it does not establish that Issues was off.

After deployment, the staging pipeline now reads exact current Worker resources,
legacy settings, and script-settings from the fixed Cloudflare API origin using
its existing environment credential. It brackets these reads with unchanged 100%
serving deployment IDs, requires explicit independent Issues=false (absence is
unverified for this acceptance gate), and prints only sanitized capture flags and
immutable version IDs. Responses stay bounded and in memory; no raw provider body,
binding, secret, or header is printed. No local credential-cache extraction or
extra writer is used. Human OAuth callback acceptance must await this positive gate.

## Provider normalization: precise canonical privacy interpretation (2026-10-07)

The c77 staging delivery `37617117905` deployed the reviewed source but failed an
incorrectly strict metadata gate. The independent, pure-read run `37617624810`
then bracketed the same serving versions and reported these exact safe values for
both current Worker resources: root enabled=false, Logs enabled=false,
invocation_logs=true, Traces enabled=false, and Issues missing. Both legacy views
omitted all five fields. The current versions remained Billing
`2fa3e271-3e93-4b03-a67d-2332f14f0e1d` and Subscribe
`f4682841-2008-4a0f-8b6e-9016c64ca9ca`. No writer ran during diagnosis.

This is not a generic missing=false inference. Cloudflare's official
[Issues enablement contract](https://developers.cloudflare.com/workers/observability/issues/)
requires explicitly enabling Issues and says deploying without
`observability.issues.enabled=true` turns it off. The opt-in Issues **section**
being absent on the exact current resource therefore means off; a present Issues
section with an unknown or true enabled field still fails. Source configuration
continues to explicitly set Issues=false. Root, Logs and Traces must each be
explicitly false on the current resource; missing values there always fail.

The independently established Mail canonical implementation is
`D:/Code/moesegfault-amail/crates/mail-worker/check_observability.py`:
`capture_disabled`, lines 68–117, accepts only the absent opt-in Issues section,
and `effective_api_settings`, lines 144–165, requires the exact current resource
and noncontradictory legacy views. A disabled Logs subsystem cannot emit retained
invocation logs; invocation_logs=true is only an inactive preference and is
reported truthfully, not rewritten false. The official
[Workers Logs enablement contract](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
requires enabling observability for logs to be written. This interpretation is
valid only with explicit root=false and Logs=false, never as a substitute for
those switches or as a way to accept active logging.

The reader now matches that precise canonical policy and adds tests rejecting
Issues=true, a present unknown Issues section, missing root/Logs/Traces, and Logs
on. A pure-read verification run must establish the unchanged versions under this
policy; no code/settings redeployment is needed just to alter normalized preference
values. The earlier strict-absence paragraph above is superseded by this evidence
and contract, not by a relaxed assumption.
