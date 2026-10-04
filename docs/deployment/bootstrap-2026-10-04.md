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

## Initial CI route

The default `main` branch is unprotected and has no active rulesets. Root owns
commits/pushes. One initial main push triggers Rust/frontend validation,
checksummed immutable package, and staging deployment. There is no production
job/configuration, no skip-CI exception, and no redundant manual bootstrap run.
Future manual branch releases use `delivery=staging-only`; `verify-only` does not
deploy. Hosted Rust release builds use matching `worker-build`/`worker` 0.8.6 and
cached, pinned Rust 1.88 with two compile threads.
