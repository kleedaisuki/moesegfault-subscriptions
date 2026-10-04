# Local administrator issuance

This release is deployed to staging only. See the [staging acceptance report](validation/staging-e2e-2026-10-05.md) for the end-to-end result; production has not been deployed.

## Setup

Run `node scripts/admin-key.mjs --init` once. It generates 32 random bytes in the ignored repository-local `.secrets/billing-admin-key`. The create-only command never rotates an existing key. POSIX permissions are owner-only; Windows removes inherited ACLs and grants the current user full control. Neither the human nor an agent needs to inspect the value.

Provision that file into the selected Worker's `BILLING_ADMIN_KEY` through a subprocess stdin, never a command argument, terminal output, GitHub log, or frontend bundle. Provision `ADMIN_EMAIL` separately from private environment configuration; do not embed its recipient value in source or documentation. It is replaceable without editing code. Cloudflare's `EMAIL` send binding must permit only the sender `subscribe@moesegfault.dev`, and the domain must be enabled for Email Sending.

`node scripts/deployment-secrets.mjs` is the private staging provisioning command. It requires the repository-local secret sources prepared by the deployment operator and prints only secret names and provisioning status. Do not print or copy those source contents into a terminal transcript or agent context.

The key is intentionally an administrator capability: possession authorizes issuance. Keep the workstation account and secret backups protected. Ignoring a file in Git does not protect it against local malware or a compromised account.

## Issue and recover

```powershell
node scripts/admin-issue.mjs --plan platform-monthly
# Use the printed non-secret UUID after timeout or interrupted execution.
node scripts/admin-issue.mjs --resume ORIGINAL_UUID
```

The script defaults to staging, accepts only the fixed staging / production billing origins, refuses redirects, has a 20-second request deadline, and stores the original non-secret intent under `.secrets/issuance/`. Recovery replays exactly that plan, environment, and UUID. No credential or activation code is printed or stored in the intent.

The production selector is reserved for a separately provisioned future deployment; it does not deploy or configure production. Choose other plan IDs from `infra/plans.staging.json`. To register a plan, edit that catalog, run `npm run plans:sync` and `npm run plans:check`, and commit the catalog plus synchronized Worker configuration for CI deployment. See [plan operations](../skills/moesegfault-billing/references/plans.md).

`POST /v1/admin/activation-codes` receives `{ "plan_id": "..." }` and the intent UUID in `Idempotency-Key`. The response is a status-only receipt. The server generates and emails the capability; it never returns a raw code to the caller.

| State | Meaning | Operator action |
| --- | --- | --- |
| `pending` | Intent exists; sending has not been claimed | Resume the same UUID |
| `sent` | Provider accepted the email | Check the configured administrator inbox; not a delivery/read guarantee |
| `unknown` | Sending was claimed but cannot be confirmed | Reconcile provider events; do not automatically issue/resend |

Provider acceptance and a database update cannot be made one transaction. The implementation therefore claims sending once and fails closed after ambiguity. This trades automatic retry availability for preventing multiple emails or newly minted codes after lost responses. Any future retry facility must reuse the same capability and establish a definite non-acceptance result before resending.

Codes are deterministically derived with a domain-separated HMAC from the immutable intent and administrator key. D1 retains only the code hash, plan snapshot, and key fingerprint, never a plaintext capability. The fingerprint prevents an unresolved intent from silently producing a different code following key rotation. Rotate intentionally and reconcile pending intents first.

## Mail confidentiality

Send directly through Cloudflare Email Sending, not the amail mailbox workflow: amail indexes eligible sent and received content through external model providers. Disable Email Preview on the sending domain if sensitive message retention is inappropriate. Production logs must exclude message bodies, codes, code hashes, recipients, and credentials.

Sources: [Cloudflare Workers Email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [send binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/), and the adjacent Identity implementation `crates/identity-worker/src/account.rs`.
