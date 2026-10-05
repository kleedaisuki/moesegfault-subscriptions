# Production promotion

## Authority and accepted runtime

On 2026-10-05 (Asia/Singapore), the user explicitly authorized production rollout
after the complete staging browser/amail acceptance. The accepted runtime source
is `0e2b8920e8946c012e2fdbab1d227ff928c2b05a`; `054b64f` only records acceptance
documentation. Promote the checksummed immutable package from successful staging
[run 37222313937](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/37222313937).
Do not recompile Rust locally or rebuild that runtime between environments.

## Isolated production resources

| Resource | Production contract |
| --- | --- |
| Billing Worker/domain | `moesegfault-billing` / `billing.moesegfault.dev` |
| Billing D1 | `moesegfault-billing-production`, `b639187a-5a0c-4af9-b1d0-b6bf863075fa` |
| Subscribe Worker/domain | `moesegfault-subscribe` / `subscribe.moesegfault.dev` |
| Subscribe D1 | `moesegfault-subscribe-production`, `d1d08305-d763-44bf-83ae-fa9839b14015` |
| OIDC issuer/client | `https://identity.moesegfault.dev` / `subscribe` |
| Callback | `https://subscribe.moesegfault.dev/auth/callback` |
| Pairwise sector | `subscribe.moesegfault.dev` |
| Account embedding/return | `https://account.moesegfault.dev` / exact `/subscriptions` |
| Sender | `subscribe@moesegfault.dev` |

Production uses separate config files, D1 UUIDs, administrator credential, OIDC RSA
key, issuer, audience, service binding and Account origin. The existing staging
files remain the default for backward compatibility. `infra/plans.production.json`
is the readable production catalog; run `npm run plans:sync:production`
and `npm run plans:check:production` before releasing a plan change. The equivalent
direct Node CLI accepts `--environment production`; explicit npm shortcuts avoid
platform-dependent forwarding of double-dash arguments.

The public production client manifest is `infra/subscribe-production-client.json`.
The Identity owner applied the reviewed forward-only production registration
through its existing deterministic generator, with scopes `openid profile` and
`private_key_jwt`. Its public key matches the independently generated private
JWK; retries reuse that key and must never silently rotate it.

Private files are under ignored, OS-user-exclusive `.secrets/production/`. The
administrator recipient is configured from its private file, not source/docs.
`scripts/deployment-production-secrets.mjs --init` is create-only; `--provision`
pipes validated private inputs to Wrangler and suppresses child output/disk logs.
`admin-key --init --environment production` reuses the same administrator key;
`admin-issue --environment production` and resumed intents select it from their
immutable original request origin. Default administrator operations remain staging.

## Explicit promotion workflow

```powershell
gh workflow run ci.yml --ref main -f delivery=production-only -f artifact_run_id=<accepted-staging-run-id>
```

Main pushes still deploy staging only. Production can run only via explicit manual
`production-only` selection on `main`, behind the `cloudflare-production` GitHub
environment; its deployment branch policy allows only `main`. Existing repository
Cloudflare secrets are used without retrieving their values. The credentialed job
does not restore npm/Cargo caches, build Rust, rebuild React, or create a second
runtime package.

The promotion job runs cheap configuration/tooling tests and the dependency audit,
then validates that the selected run belongs to this repository, completed
successfully, actually passed `Deploy staging`, and retains its unexpired exact
`staging-<source SHA>` artifact. That legacy artifact name is environment-neutral
binary/assets packaging, not a requirement to reuse staging bindings. Download
uses Actions' authenticated cross-run artifact mechanism. SHA-256 and the archive's
source revision are checked before extraction. No user-controlled input is
interpolated directly into a shell command.

Release also requires `PRODUCTION_DEPLOY_CONFIRM=production-only` in addition to
the explicit `production` script argument. It checks config names, environment
and database names before applying migrations. Billing is deployed before
Subscribe's service binding. Both Worker versions are tagged with the source
revision prefix and carry the full verified source in the version message, allowing
an independent Cloudflare version/deployment metadata readback.

References: [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
[Actions cross-run download-artifact](https://github.com/actions/download-artifact),
[Cloudflare versions and deployment annotations](https://developers.cloudflare.com/workers/versions-and-deployments/).

## Validation and recovery

Smoke checks the explicit environment's two JSON health endpoints, HTML/CSP with
its paired Account origin, anonymous BFF session projection, and unauthenticated
Billing 401. Initial custom-domain propagation waits are bounded to 90 seconds per
endpoint. Independently read back active version IDs/traffic/source annotations,
private-binding names only, registered public client metadata, and observability
booleans: custom logs enabled, invocation logs disabled, query strings redacted.
Never dump token/session/profile tables, secret values, callback queries, or raw
tail JSON to diagnose a promotion.

Use real registration/SSO, billing-profile save, activation, reload and Account
navigation for user acceptance. A single production test email may temporarily
override the recipient only under the user's separate explicit authorization.
The formal private recipient file must remain unchanged; restore it in `finally`
before browser redemption, even when retrieval or delivery fails. Unknown issuance
outcomes must resume the same stored UUID, never create another code.

D1 migrations are forward-only and applied before Worker code. They are the same
reviewed additive migrations accepted in staging. A Worker rollback does not roll
back D1 or secret/key registration. Never restore a database snapshot to reverse a
deployment: that can revive consumed activation codes or invalidate ownership.
For an incompatible schema, keep the current data and make a forward code/schema
repair. For later compatible releases, select a previously healthy Worker version
and roll Subscribe back before Billing, then run production smoke. The first live
release has no older healthy production Worker; a secret-provisioning placeholder
is not a rollback candidate.

Known baseline before first live deployment: no production Billing/Subscribe user
data existed. Staging data and secret files were neither reused nor reset. Record
the actual promotion run and independent serving metadata below after release.
