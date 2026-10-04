# Staging bootstrap, 2026-10-04 (Asia/Singapore)

## Completed infrastructure operations

- Created isolated `moesegfault-billing-staging` D1 database with UUID
  `47022fe7-0e14-4bbb-a52a-c59358b938b1` and isolated
  `moesegfault-subscribe-staging` database with UUID
  `8c2435df-3dcd-4bc8-a6ee-9798fa150a96`. No production database changed.
- Generated a create-only ignored local administrator credential and RSA OIDC
  private JWK. The private files are protected with Windows user-exclusive ACLs
  and `git check-ignore` confirms all three `.secrets` paths are excluded.
  Values were never printed or included in this document.
- With explicit user authorization, staging `ADMIN_EMAIL` was subsequently
  changed to an owned test mailbox accessible through local amail. Only that
  secret was reprovisioned; the administrator key and OIDC key were not rotated.
  The staging override remains configured for acceptance. The requested final
  administrator inbox will be configured independently before production; no
  production configuration or mailbox was changed.
- Provisioned Billing `BILLING_ADMIN_KEY`, `ADMIN_EMAIL` and Subscribe
  `CLIENT_PRIVATE_KEY_JWK` through Wrangler stdin with captured/suppressed output.
  Name-only Wrangler secret lists confirmed those bindings exist.
- Created the GitHub `cloudflare-staging` deployment environment. Existing
  repository `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secret names were
  verified, never retrieved. R2 credential names also exist but are unused.
- Generated public `infra/subscribe-staging-client.json` and used the neighboring
  Identity repository's existing audited generator to create
  `0009_oauth_client_subscribe-staging.sql`. Root inspected and approved the exact
  manifest and SQL before the configuration-only staging overlay was applied.
  Its normal prepared migration stream contained 7 common + 2 staging migrations;
  only the new 0009 was pending. D1 applied 9 SQL statements in 3.03 ms.
- Read back public client/redirect/scope metadata: `subscribe-staging`,
  `confidential`, `private_key_jwt`, sector
  `subscribe-staging.moesegfault.dev`, enabled state; exact redirect
  `https://subscribe-staging.moesegfault.dev/auth/callback`; scopes
  `openid` and `profile`. No Identity service implementation was modified or
  redeployed. The existing Identity production delivery note is unrelated and
  must not be accidentally committed with this migration.
  The approved migration is now durable in Identity commit `a2e25e4` on
  `codex/subscription-section`, following Account UI commit `704ff67`; only its
  public SQL file was staged for the configuration-specific commit.
- Confirmed existing Cloudflare Email Sending is enabled for `moesegfault.dev`
  with `cf-bounce` DKIM and return-path configuration. This supports the sender
  domain but is not evidence of delivery to the administrator inbox; that is an
  acceptance step.

Billing and Subscribe migrations were deliberately left pending until the first
verified release. No user/token/session rows were read during infrastructure work.

## Cheap local acceptance of deployment tooling

- `npm install --ignore-scripts --no-fund --no-audit`: 85 packages, 39 seconds.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `npm run typecheck`: passed.
- `npm test`: 11 frontend tests passed in 378 ms.
- `npm run test:deployment`: 11 Node deployment/admin/session SQL tests passed
  in approximately 108 ms.
- Python billing SQL suite: 16 tests passed in 69 ms, including real concurrent
  SQLite redemption arbitration; admin SQL suite: 3 passed in 4 ms.

These are local tooling/SQL checks, not the final hosted build or real user
acceptance result. Record the release run, deployed versions, smoke and browser
journey separately after the first GitHub Actions pipeline completes.

## First hosted release and actionable findings

Root pushed initial `main` revision `d4bf3ad94afe85ed544ebd6ed810e3e1cbc53290`.
[Actions run 37214656055](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/37214656055)
built and packaged successfully: Rust cold tools/tests/two WASM builds took
5 minutes 15 seconds; frontend/contracts 23 seconds; immutable package 20 seconds.
The deploy job applied Billing 0001/0002 and Subscribe 0001, then uploaded both
Workers and their custom-domain routes. Billing version
`cc0b4944-d303-43ed-ba57-063b858dc2c9`; Subscribe version
`b00b1e8a-a8dd-4ae6-8c84-91413098a65c`. Asset upload contained 14 files, 10 newly
uploaded, with 1.28 seconds of upload time. Both Worker startup measurements were
4 ms.

The overall run failed at final smoke because the first Subscribe hostname lookup
returned `ENOTFOUND` immediately after route creation; Billing health had passed.
Account-level Cloudflare domain metadata then confirmed both staging hostnames
enabled with certificates, and public Cloudflare DNS-over-HTTPS resolved both A
records. No missing credential or domain record was found, so no broad DNS changes
were made. Smoke's initial 4-second retry window was extended to a hard maximum
90 seconds per endpoint; the Rust job deadline was reduced from 25 to 15 minutes
using observed cold-build evidence.

A subsequent proxy-backed guest probe uncovered a distinct real runtime defect:
Subscribe `/healthz`, `/api/catalog`, and `/api/session` returned 200, but `/` and
`/index.html` returned raw 500. This isolates failure to the static-assets response
path rather than Billing bindings or OIDC credentials. The Subscribe owner fixed
immutable asset-response header mutation by cloning its headers while preserving
stream/status/cache semantics; the successful warm release and actual edge probes
are recorded in [the release note](release-2026-10-05.md).
Do not mark the first deployment accepted merely because the upload succeeded;
the actual UI must load and the browser journey must close.

## Initial CI route

The default `main` branch is unprotected and has no active rulesets. Root owns
commits/pushes. One initial main push triggers Rust/frontend validation,
checksummed immutable package, and staging deployment. There is no production
job/configuration, no skip-CI exception, and no redundant manual bootstrap run.
Future manual branch releases use `delivery=staging-only`; `verify-only` does not
deploy. Hosted Rust release builds use matching `worker-build`/`worker` 0.8.6 and
cached, pinned Rust 1.88 with two compile threads.
