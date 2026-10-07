# Staging migration parser recovery — 2026-10-07

## Failure and authoritative remote state

Staging delivery run `37615238720` successfully provisioned the dedicated service
credential on both Workers, then failed applying `0003_amail_authorizations.sql`:
D1 returned `incomplete input: SQLITE_ERROR [7500]`. Later migrations and the new
Worker code were not released. No reset or destructive repair was attempted.

A subsequent fixed, names-only remote read used the pinned Wrangler 4.147.0 staging
configuration. Its migration list still showed 0003, 0004 and 0005 pending.
`SELECT name FROM d1_migrations ORDER BY id` returned only `0001_billing.sql` and
`0002_admin_issuance.sql`; `SELECT name FROM sqlite_master WHERE type='table' AND
name LIKE 'amail_%' ORDER BY name` returned no rows. Both result metadata objects
reported `changed_db:false` and `rows_written:0`. Thus the failed 0003 transaction
rolled back; no partial amail tables existed at the recovery read. Local readback
required removing an unavailable proxy only from that child process, not changing
machine-wide networking or deployment credentials.

## Minimal repair and regression scope

The payer-conflict trigger used `SELECT CASE ... END;`, an ambiguous boundary for
the remote D1 SQL splitter. It now uses the equivalent, simpler
`SELECT RAISE(...) WHERE EXISTS(...)`: one trigger END, no nested CASE END.
The 0004 usage triggers already contain no CASE expressions and need no semantic
changes. The failed, unapplied migration is repaired in place; no rollback/reset
migration or user-data rewrite is needed.

The actual pinned Wrangler module exports `unstable_splitSqlQuery`. The new
regression imports that real implementation, splits every Billing and Subscribe
migration, and executes each resulting statement independently on SQLite. It also
rejects CASE in the new amail trigger guards. Importantly, the current local
Wrangler splitter already returns a complete trigger for the old SQL: this test
is not claimed to reproduce the older/different service-side splitter failure.
The no-CASE guard specifically removes the problematic remote grammar shape;
actual D1 acceptance remains the next staged delivery run.

The staging release now prints the same fixed names-only migration/table readback
before applying Billing migrations, preserving visible recovery evidence without
reading customer rows. Production deployment behavior and configuration are unchanged.
