# Plan operations

Readable catalogs and their synchronized configurations are environment-specific:

| Environment | Catalog | Billing configuration |
| --- | --- | --- |
| Staging (default) | `infra/plans.staging.json` | `wrangler.billing.jsonc` |
| Production (explicit) | `infra/plans.production.json` | `wrangler.billing.production.jsonc` |

Each entry defines stable
`id` and `product_id`, Chinese / English / Japanese names and descriptions,
`duration_days`, `active`, and entitlement identifiers. It is reviewed deployment
configuration, not an administrator API or a secret.

## Change and release

1. Edit the catalog; use a new stable ID for a meaningfully different grant.
2. Synchronize and check the generated Worker variable:

   ```sh
   npm run plans:sync
   npm run plans:check
   # Production is explicit; these commands never alter staging's catalog.
   npm run plans:sync:production
   npm run plans:check:production
   ```

3. Commit the selected environment's catalog and Billing configuration. CI rejects
   catalog drift. Main automatically deploys staging only; production requires an
   explicitly approved promotion of an accepted immutable artifact with reviewed
   production configuration, without rebuilding Rust.
4. After the release, issue using the registered ID:

   ```sh
   node scripts/admin-issue.mjs --plan PLAN_ID
   node scripts/admin-issue.mjs --plan PLAN_ID --environment production
   ```

Existing codes preserve their product, duration, and entitlement snapshot. Do not
reuse an ID to reinterpret an issued grant. Set `active: false` to stop new issuance
without rewriting previous grants. Product IDs determine subscription uniqueness;
display-name edits must not change product identity. While active, a subscription
can extend only its current plan; a different plan is eligible after expiry.

The default remains staging for compatibility. The production issuance selector
uses the independent production administrator key and configured private mailbox;
it does not deploy Workers. See the [staging deployment guide](../../../docs/deployment/staging.md)
and [production promotion guide](../../../docs/deployment/production.md) for release
mechanics. The [staging acceptance report](../../../docs/validation/staging-e2e-2026-10-05.md)
records the completed staging journey, not an automatic production acceptance.

Use the explicit production npm shortcuts rather than forwarding `--environment`
through npm, which can consume the flag on some Windows/npm combinations. Direct
`node scripts/deployment-plans.mjs --environment production` (append `--check`
for validation) is also supported.
