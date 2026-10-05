# Administrator operations

The local script is the supported issuance interface. Read [the operations runbook](../../../docs/admin-operations.md) for setup, delivery states, and recovery. Do not load `.secrets` contents into an agent context.

```powershell
node scripts/admin-key.mjs --init
# Provision using the repository deployment-secrets script; never display the key.
node scripts/admin-issue.mjs --plan platform-monthly
node scripts/admin-issue.mjs --resume ORIGINAL_UUID
# Production selects its independent key explicitly; recovery still uses only UUID.
node scripts/admin-key.mjs --init --environment production
node scripts/admin-issue.mjs --plan platform-monthly --environment production
```

The administrator credential is a random local secret, not an Identity user token. The Worker receives it privately as `BILLING_ADMIN_KEY`. `ADMIN_EMAIL` is an independently replaceable Worker secret. Activation mail is sent directly from `subscribe@moesegfault.dev`; do not use amail's automatically indexed sent-mail path for bearer-code distribution.

Issuance defaults to staging. Production selects its independent administrator key; recovery derives the key from the validated immutable intent origin, without replacing the environment or plan. Administrator and OIDC keys are isolated under `.secrets/production/`; read [production bootstrap](../../../docs/deployment/production-secrets.md) before provisioning. Configure each environment's recipient privately as `ADMIN_EMAIL`; never hard-code or publish its value or copy a staging test override. Read [plan operations](plans.md) when adding a plan and the [staging acceptance report](../../../docs/validation/staging-e2e-2026-10-05.md) for the completed staging journey. Production acceptance requires its own run.

Do not bypass a provider restriction, turn off authentication, return a raw code as a fallback, or issue a new intent merely because delivery is uncertain. The mail provider's acceptance receipt is not evidence that the administrator received or read the email.
