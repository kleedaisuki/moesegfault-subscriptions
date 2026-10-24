# Production promotion

## Authorized subscription experience and Agents return release — 2026-10-24

The owner explicitly requested publication and confirmed that the complete Agents
main version should ship after its staging gate passes. This authorizes the
subscription UI/SSO/performance release and the coordinated application return
`https://adash.moesegfault.dev/billing/return`, not a new OAuth callback, scope,
subject sector, payment provider, activation issuance or spending authorization.
The existing Account continuation remains accepted. Staging and production lists
are exact, separately paired URLs; no origin wildcard is introduced.

Merge the reviewed Subscribe PR, let that exact main commit complete its actual
staging delivery, then use the existing main-only immutable-artifact promotion.
Publish Subscribe's production allowlist before the Agents production app so its
new return hint cannot be rejected. Agents must separately clear its full current
staging gate before production delivery; the earlier roundtrip-only acceptance
does not relabel the archive-failed deployment as green. Preserve every existing
production D1, key, issuer, audience, catalog grant and service binding. Record
actual release IDs and production browser readback below after execution.

### Completed production release receipt

The authorized coordinated release completed on **2026-10-24 Asia/Singapore**.
Subscribe [PR #3](https://github.com/kleedaisuki/moesegfault-subscriptions/pull/3)
and Agents [PR #7](https://github.com/kleedaisuki/moesegfault-agents/pull/7) were
normally merged. The accepted runtime is the authoritative main implementation,
not the unmerged local stream-recovery experiment; overlapping PR #8 was closed
as superseded by the main run-scoped Observer/projection-repair implementation.

| Production unit | Accepted source | Final serving version / traffic |
| --- | --- | --- |
| Billing | `6c3586eb6681b21daf0c61af658c3c9f9fb4c974` | `c074158a-909c-416f-9a4d-62209d2738f2`, 100% |
| Subscribe | Same source | `5833e616-d528-4fa4-91b4-bf2fbac2492b`, 100% |
| Agents | `265e0ea8bd557d540077afced3bb20b735bbfdfc` | `d198f098-1278-44f8-a2dc-90d62de3a9bc`, 100% |

Subscribe main's [actual staging run 40094394703](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/40094394703)
passed before [production promotion 40102195561](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/40102195561)
reused the same checksum-verified WASM/frontend artifact. Rust and React were not
rebuilt for production. Capture settings and production smoke passed.

Agents [full CI 40100503604](https://github.com/kleedaisuki/moesegfault-agents/actions/runs/40100503604)
and [staging deployment 40100946077](https://github.com/kleedaisuki/moesegfault-agents/actions/runs/40100946077)
passed with **25/25 actual-WASM checks and 14/14 real SDK journeys**, including
compaction, steering and workspace restoration. These are new accepted-source
results; earlier archive/stream-failed runs were not relabeled successful.

Agents [production 40102985955, attempt 2](https://github.com/kleedaisuki/moesegfault-agents/actions/runs/40102985955)
completed successfully after the upstream Subscribe production continuation was
verified ready. Attempt 1 had uploaded the Worker and applied migration 0010,
then Cloudflare returned an internal error updating the Container application.
Readback confirmed that partial state before an idempotent failed-job retry of
the **same** source/artifacts. No reverse migration, grant reset or new key
generation was used. Attempt 2 completed deployment, authoritative secret
reassertion, diagnostic retention and public smoke. Its code-upload version was
`14b54de5-9eef-43e5-a369-084dbd55cffe`; the final secret-only version is the one
listed in the table, and both production host health responses report source
`265e0ea8bd557d540077afced3bb20b735bbfdfc`.

The production Container application is version **3 at 100%**, maximum 20
instances, configured with the accepted `magents-workspace:265e0ea...` tag.
Staging application version 12 uses the same tag. Both registry publication logs
report manifest digest
`sha256:9114bc4855b4227dd5f2116cbde291c8cc874b184d49e7634bc1c97336bce206`.
This is matching publication evidence, not a claim that the App API exposes a
resolved image digest or that old active instances bypass rollout grace.

#### Preservation and actual browser readback

- All **seven existing production plans deep-equal the before snapshot**. Existing
  secret-binding names and public binding fingerprints match, except the intended
  Subscribe return allowlist and Agents BUILD_ID. Secret values were not retrieved
  or compared; existing authoritative production inputs were reasserted, not
  generated or copied from staging.
- Agents' only newly applied D1 migration was
  `0010_generic_provider_credentials.sql`: a data-preserving credential-table
  rebuild with legacy CRUD compatibility. Pre/post credential row count, encrypted
  byte count and key-version sum were all zero; metadata columns appeared as
  expected. Accounts, sessions, ledgers, conversations and user buckets were not
  reset. Keep that schema forward on rollback; an old binary cannot execute new
  generic-protocol workloads merely because its vendor CRUD remains compatible.
- Exact production Agents return is accepted; the staging destination is rejected
  by production with HTTP 400. Both production services' smoke and the independent
  post-release metadata/catalog checks passed.
- At **22:46:16 Asia/Singapore**, an existing explicitly owned synthetic production
  account completed the actual same-tab **Manage subscription → Subscribe SSO →
  reload → Return to app → `/billing/return` HTTP 302 → `/#usage`** journey.
  Account and usage were freshly read on return; the original account fingerprint,
  **Free / live**, zero owned subscriptions, wallet and billing profile remained
  unchanged. The account dashboard had no catalog cards, no credential re-entry,
  no alert and no browser page error. Serving Agents SHA and Subscribe asset
  `/assets/index-CvvppnyQ.js` were checked before the journey.
- This production acceptance issued/redeemed **no activation code**, created no
  account/mailbox and approved no spending or new wallet funding. Private state,
  profile, credential custody and masked screenshots remain owner-protected under
  repository-local `.temp/production-release-20261024/private`, not in Git.
  The initial browser harness missed the intermediate 302 by observing only
  committed frames; it was corrected to assert the actual navigation request,
  exact HTTP 302/Location and final document, without weakening the expected loop.

## Current amail USD promotion authority — 2026-10-08 Asia/Singapore

The owner now explicitly authorizes the accepted amail v0.2.0 USD bridge in
production. Promote immutable runtime86bb06e from successful staging37641220454;
production configuration/tooling is separate from that artifact's runtime source.
Keep existing production platform plans, Identity client/sector, D1s, session
keys and formal administrator recipient. Add Free/Lite/Plus at fixed USD0/1.50/4.50,
and overage0.001/recipient,0.15/GB-month,0.50/address-month. Billing still uses
activation grants and pending-settlement liability, not automatic payment.

An independent create-only production AMAIL_SERVICE_KEY is provided through the
protected cloudflare-production environment, matching Mail production's separate
BILLING_SERVICE_KEY. Both service destinations are validated before the first
secret update. Explicit production confirmation is required; staging remains the
default. Both production services now disable automatic HTTP Logs/Traces/Issues
and verify exact current-version capture settings before smoke. The amail return
allowlist contains only https://amail.moesegfault.dev/billing/return. Source-owned
Mail predecessor/rolling schema and ownership acceptance are in the Mail repository
`docs/v0.2.0/production-delivery.md`. Actual promotion/readback will be recorded
below once successful; the earlier production epoch remains historical evidence.

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
