# Plan operations

Staging's readable catalog is `infra/plans.staging.json`. Each entry defines stable
`id` and `product_id`, Chinese / English / Japanese names and descriptions,
`duration_days`, `active`, and entitlement identifiers. It is reviewed deployment
configuration, not an administrator API or a secret.

## Change and release

1. Edit the catalog; use a new stable ID for a meaningfully different grant.
2. Synchronize and check the generated Worker variable:

   ```sh
   npm run plans:sync
   npm run plans:check
   ```

3. Commit both `infra/plans.staging.json` and `wrangler.billing.jsonc`. CI rejects
   catalog drift and deploys the reviewed `PLAN_REGISTRY_JSON` with staging.
4. After the release, issue using the registered ID:

   ```sh
   node scripts/admin-issue.mjs --plan PLAN_ID
   ```

Existing codes preserve their product, duration, and entitlement snapshot. Do not
reuse an ID to reinterpret an issued grant. Set `active: false` to stop new issuance
without rewriting previous grants. Product IDs determine subscription uniqueness;
display-name edits must not change product identity. While active, a subscription
can extend only its current plan; a different plan is eligible after expiry.

These commands synchronize staging only. Production has not been deployed; a CLI
production selector does not create a production configuration. See the
[staging deployment guide](../../../docs/deployment/staging.md) for release mechanics
and [acceptance report](../../../docs/validation/staging-e2e-2026-10-05.md) for the
integrated user journey.
