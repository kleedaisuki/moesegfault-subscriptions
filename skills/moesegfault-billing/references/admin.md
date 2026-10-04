# Administrator operations

The local script is the supported issuance interface. Read [the operations runbook](../../../docs/admin-operations.md) for setup, delivery states, and recovery. Do not load `.secrets` contents into an agent context.

```powershell
node scripts/admin-key.mjs --init
# Provision using the repository deployment-secrets script; never display the key.
node scripts/admin-issue.mjs --plan platform-monthly
node scripts/admin-issue.mjs --resume ORIGINAL_UUID
```

The administrator credential is a random local secret, not an Identity user token. The Worker receives it privately as `BILLING_ADMIN_KEY`. `ADMIN_EMAIL` is an independently replaceable Worker secret. Activation mail is sent directly from `subscribe@moesegfault.dev`; do not use amail's automatically indexed sent-mail path for bearer-code distribution.

Issuance defaults to staging; production has not been deployed. Configure the intended administrator recipient privately as `ADMIN_EMAIL`; do not hard-code or publish its value. Read [plan operations](plans.md) when adding a plan and the [staging acceptance report](../../../docs/validation/staging-e2e-2026-10-05.md) for the release's user journey.

Do not bypass a provider restriction, turn off authentication, return a raw code as a fallback, or issue a new intent merely because delivery is uncertain. The mail provider's acceptance receipt is not evidence that the administrator received or read the email.
