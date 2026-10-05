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

## First production promotion, 2026-10-05

Configuration/tooling source `7af67707d2b689683239665f740eaac0c43cb122` introduced
the explicit promotion mechanism. [Run 37269327535](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/37269327535)
was manually dispatched with `delivery=production-only` and accepted artifact run
`37222313937`. The production job succeeded in **41 seconds**; Rust, frontend,
package and staging jobs were all skipped. Including its ordinary main-workflow
queue, the dispatch ran from `2026-10-05T05:47:18Z` to `05:49:10Z`, corresponding
to 13:47:18–13:49:10 in Asia/Singapore. It deployed the **same** accepted runtime
`0e2b8920e8946c012e2fdbab1d227ff928c2b05a`, not a fresh build.

Production smoke passed inside Actions and independently from the configured
proxy host: both health endpoints, HTTPS HTML/CSP paired with production Account,
guest session, and Billing unauthenticated 401. Account-level custom-domain
readback confirms both intended hostnames enabled on their intended Workers.
Production Identity's public discovery independently returned 200 JSON with its
exact production issuer. Its owner read back the enabled exact client registration.

After the authorized one-email test and formal-recipient restoration, actual
deployment API readback confirms:

| Unit | Current serving version | Traffic |
| --- | --- | ---: |
| Billing | `65ee60bf-3862-4f6a-9cbb-60a2a40a25c1` | 100% |
| Subscribe | `e1c926fe-297c-4972-8809-136f10fc5ea5` | 100% |

Subscribe's version annotations identify prefix `0e2b8920e894` and the full
accepted runtime source. Wrangler secret updates/restoration created subsequent
Billing configuration versions and cleared those annotations; their code was not
rebuilt or changed. Record this distinction rather than falsely claiming a Git tag
on the final secret-only version. Name-only binding readback confirms production
Billing `ADMIN_EMAIL`/`BILLING_ADMIN_KEY` and Subscribe `CLIENT_PRIVATE_KEY_JWK`.
Both Workers retain custom logs enabled, invocation logs disabled, and query
redaction enabled. No secret contents or account/profile/token rows were dumped.

## Authorized single-mail validation

The user separately authorized exactly one production test mail to the owned test
mailbox, followed by immediate formal-recipient restoration before redemption.
The private formal file was never modified. Original immutable intent
`9b94cb58-3ba0-4391-956e-138ac0621812` was sent once after
`2026-10-05T05:50:40.472Z`; the provider accepted it. Bounded mailbox retrieval did
not confirm receipt within 180 seconds. The helper restored the formal recipient
in `finally` and emitted `formal_recipient_restored=true`; no additional intent,
alternate alias or duplicate mail was created.

Two explicitly authorized narrow zone-level Email Sending GraphQL probes for
the original time interval returned zero events: first the exact service sender,
then the same window and limit with its sending domain instead. They requested
only delivery metadata and would compare recipients in memory, printing
categories rather than addresses; neither requested bodies or subjects. No
further queries or sends were performed. This absence does not establish a
bounce, wrong-recipient delivery, or a provider failure. The Billing owner records
the bounded diagnostic and missing provider-message-ID correlation separately.
The root agent owns final real production signup/profile/redemption acceptance;
provider acceptance is not falsely described as actual inbox receipt.
