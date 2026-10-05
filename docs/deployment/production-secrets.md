# Production credential bootstrap

Production storage is independent from staging. No activation email is sent by this bootstrap.

## Create once

```sh
node scripts/deployment-production-secrets.mjs --init
```

The command prepares Git-ignored, owner-only `.secrets/production/`, then creates:

| Private local file | Worker secret |
| --- | --- |
| `billing-admin-key` | Billing `BILLING_ADMIN_KEY` |
| `admin-email` | Billing `ADMIN_EMAIL` |
| `subscribe-private.jwk` | Subscribe `CLIENT_PRIVATE_KEY_JWK` |

The administrator key is 32 independent random bytes; the signing key is RSA 2048-bit with RS256. Initialization never replaces existing private files. Existing credentials are validated; unexpected symlinks, malformed inputs, or conflicting public metadata fail closed. Private material is never printed.

An authorized operator initializes `admin-email` separately, using an exclusive local write into the protected directory, with the requested production mailbox. Do not put its value in source code, command output, documentation, or a test-recipient override. Apply the existing `protect()` helper to that file after writing it. No email address is hardcoded in this script.

The public output `infra/subscribe-production-client.json` can be committed and used for Identity client registration. It contains only the public RSA key and exact production callbacks. Re-running `--init` preserves the same keys and manifest. Rotation requires a separately designed, coordinated operation; deleting private files is not a supported rotation procedure.

## Provision

```sh
node scripts/deployment-production-secrets.mjs --provision
```

Provisioning preflights all three secret files, both production configs, and the exact installed Wrangler version before any remote write. It accepts only `moesegfault-billing` and `moesegfault-subscribe` with `ENVIRONMENT=production` and no implicit Wrangler environments. Config files must use the repository's JSON subset of JSONC.

Values are passed through stdin to repository-local pinned Wrangler, never command arguments. Child stdout/stderr are discarded and `WRANGLER_WRITE_LOGS=false` prevents hidden diagnostic logs. Each operation has a 60-second timeout. Output contains only secret names and status; failures are deliberately generic. Check authentication and public configuration separately rather than enabling verbose secret transport logs.

Remote secret puts are individually committed by Cloudflare, not transactional. After a partial failure, rerun provisioning with the same unchanged local files. Provisioning does not deploy code, rotate credentials, or issue activation codes. Production issuance must use its independent administrator key and production mailbox; staging overrides must not be copied.

## Focused verification

```sh
node --test scripts/tests/production-secrets.test.mjs
```

The tests exercise public metadata, strict production targets, typed secret input, and stdin/logging contracts using synthetic fixtures. They make no network calls and do not read production private files.
