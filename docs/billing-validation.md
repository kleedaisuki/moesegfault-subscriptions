# Billing SQL invariant validation

## Contract and method

`tests/test_billing_sql.py` validates the grant contract documented in
`docs/api-contract.md`: one redemption per activation code, account-scoped retry
keys, immutable grant receipts, and extensions from `max(period_end, now)`.
The safe-plan contract permits active-period extension only for the same plan;
a different plan must leave its code unconsumed until the product expires.

The harness applies the real `migrations/billing/0001_billing.sql`, plus the admin
migration for its send-claim check. It extracts the literal redemption INSERT and
receipt SELECT from `crates/billing/src/repository.rs` and the send-claim UPDATE
from `crates/billing/src/admin.rs`. Thus it tests the actual expiry/conflict
predicate and binding order, not a separately maintained approximation. Expected
timestamps, entitlements, ownership, and receipt contents are asserted independently
from implementation output.

Reproduce from the repository root:

```shell
python -B -m unittest discover -s tests -v
```

Only Python standard-library modules are required. The concurrency check uses two
independent SQLite connections and a thread barrier, writing its disposable
database beneath repository-local `.temp/billing-sql-*`. It explicitly closes
connections before cleanup, including on Windows (a SQLite connection context
manager commits/rolls back but does not close the connection).

## Observed result

Windows, Python 3.14.6, SQLite 3.50.4: **16 tests passed in 0.066 seconds**. No Rust
compilation, server, browser, cloud calls, or external test dependencies are needed.

| Claim | Exercised outcome |
| --- | --- |
| Accepted redemption | Complete active subscription and stored receipt created together |
| Code reuse by another principal | No second subscription or receipt |
| Identical retry | No duration extension and unchanged receipt |
| Different code under existing retry key | Original request hash retained; second code unconsumed |
| Same retry key for unrelated accounts | Both independent valid codes accepted |
| Active subscription extension | Remaining time and original start retained; full new duration added |
| Expired subscription extension | Start resets to now; full new duration retained |
| Active different-plan request | Existing grant unchanged; rejected code remains usable by another account |
| Expired plan switch | At the exact expiry boundary, new plan/entitlements apply without changing the prior receipt |
| Multiple products | Grants remain separate per account/product |
| Code expiry | Expired and exact-boundary codes rejected; one-second future code accepted |
| Unknown code | No redemption or grant |
| Invalid duration | Schema rejects grants below one day or above 315360000 seconds |
| Trigger failure | Invalid entitlement JSON rolls back both receipt and subscription |
| Principal identity | Duplicate issuer/subject rejected; same subject under another issuer allowed |
| Competing clients | Exactly one winner, one durable receipt, one subscription after simultaneous writes |
| Admin send claim | Wrong fingerprint cannot claim; original key claims once; unknown state cannot resend |

## Scope and next integration check

These results establish SQLite statement/trigger invariants, not a complete staging
acceptance verdict. They do **not** exercise D1 remote transport or read consistency,
Workers bindings, token validation, HTTP response serialization/status codes,
email delivery, or browser session flow. The admin test validates the database
claim, not provider acceptance or recovery after a Worker interruption.

The next consequential check is the deployed D1/Workers flow: issue through the
administrator script, receive email, sign in through Subscribe, redeem, observe the
subscription, and retry the same request. This also verifies the D1 change metadata
used for the `replayed` response and access from the real authenticated session.

The SQL tests are suitable for the cheap CI validation stage; they should not
trigger an additional build job or independent heavy tool installation.

## Account reads and profile-save round trips (2026-10-24)

The portal's dominant returning-user workload previously issued an attempted
account INSERT before every lookup, then fetched subscriptions and awaited two
separate trace-persistence requests. Account ownership already matches the product
hierarchy: one profile/address per principal, many product subscriptions per
account, and multiple catalog plans per product. No cardinality migration is needed.

`repository::ensure_account` now reads first. Existing principals require one
read and no account write or random account-ID generation. First use inserts with
`RETURNING`; a losing concurrent INSERT reads the winning row without modifying
its profile or timestamps. The unique `(issuer, subject)` constraint remains the
arbiter. Profile replacement uses `UPDATE ... RETURNING`, so its response contains
the exact write's account rather than a later concurrent writer's profile.

Trace insertion and indexed, 128-row-bounded expiry cleanup use one D1 batch. Trace
schema, privacy policy and retention are unchanged. Trace failure still cannot
invalidate a committed action. No asynchronous token/profile cache was introduced.

| Steady-state Billing route | Prior D1 requests | Current D1 requests |
| --- | ---: | ---: |
| GET `/v1/me` (existing account) | 5 | 3 |
| PUT `/v1/me/profile` (existing account) | 6 | 3 |

Counts include trace persistence and exclude a cold Identity key fetch. They are
structural transport counts, not a claim of measured end-to-end speedup. The trace
batch still executes two SQL statements in one request. First-account creation
uses two account requests; a simultaneous losing creation uses three. This rare
path preserves existing users rather than overwriting their data to save a lookup.

`tests/test_billing_account_sql.py` extracts actual Rust SQL and checks returned
account columns, creation conflicts, read-only repeated lookups, full address
replacement/clearing, isolation from other principals, and a shared account
profile across two product subscriptions. Together with the original grant suite,
**22 SQLite tests passed** on Python 3.14.6 in 0.276 seconds. These checks cover SQL
semantics; staging must additionally save/reload the profile through the deployed
BFF and D1 binding.

Sources informing the bounded implementation:

- [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/) recommends reducing
  request count, not only individual query execution time.
- [D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  execute prepared statements together, avoiding separate network round trips.
- [SQLite RETURNING](https://www.sqlite.org/lang_returning.html) returns changed
  rows directly; no account triggers alter the returned profile afterwards.
- [Coordination Avoidance in Database Systems](https://www.vldb.org/pvldb/vol8/p185-bailis.pdf)
  motivates reasoning from invariants: uniqueness/single-use grants still require
  database arbitration. We remove redundant transport, not the consistency boundary.
