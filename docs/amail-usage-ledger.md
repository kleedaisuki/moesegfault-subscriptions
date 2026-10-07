# amail service usage ledger

The amail machine route authenticates before calling `amail_usage::route`. It can
write usage only for an owner with a human-approved Billing binding. The API does
not accept a caller-selected Billing account ID and never joins accounts by email
or alternate Identity subjects.

## Contract

`POST /v1/service/amail/usage` takes an immutable event with `event_id`, `owner_id`,
`period_start`, `period_end`, `meter`, `quantity`, `amount_micros`, `occurred_at`, and explicit `currency:"USD"` for new usage.
Meters are `outbound_recipients`, `storage_byte_seconds`, and `address_seconds`.
Amounts are integer millionths of their persisted CNY or USD denomination; one unit is 1,000,000 micros. Missing legacy wire currency remains CNY. No sum or budget spans denominations. amail owns incremental metering, included
allowances, price calculations, and period selection; Billing owns durable
acceptance and aggregate budget enforcement. Periods must not overlap for a given
owner and currency and cannot exceed 32 days. Observations may occur after the original period,
as specified under historical consent below. A repeated event ID
with an identical payload is a successful no-op; changing any field is a 409.

The response includes `event_id`, `owner_id`, `currency`, `amount_micros`, and
`settlement_status: "pending_settlement"`, and `replayed` (derived from the atomic
write's affected-row count). This is **not** a payment receipt,
credit balance, or claim that a charge has settled. No monetary payment provider
is invoked by this ledger.

`GET /v1/service/amail/accounts/{owner}/usage?period_start=...&currency=USD` returns
`owner_id`, `period_start`, `currency`, `amount_micros`, `overage_budget_micros`,
`settlement_status`, and `events_count`. Unknown owners return 404. An unqualified legacy GET retains CNY semantics; explicit `currency=CNY` reads history. Unsupported/duplicate currencies are rejected. If the latest binding uses another denomination, the requested currency's current spending cap is zero, while its historical liabilities remain readable.

## Persistence and integer accuracy

Migration `0004_amail_usage.sql` enforces cumulative period charges against the
applicable immutable human receipt in a BEFORE INSERT trigger. Current receipt
budgets govern new admissions; legitimate older backlog retains its original cap. This executes atomically
under SQLite's writer lock, so parallel writes cannot each spend the same budget.
Budget changes do not erase existing liabilities. Expired paid bindings expose a
zero budget and cannot accrue new charges; accepted identical retries remain
available after expiry. UPDATE and DELETE are blocked.
Immutable event payload comparisons happen in SQL as well, including concurrent
retries. Query and index scope is always owner plus currency plus period.

The accepted quantity bound is 10^18; amounts and binding budgets are bounded by
10^12 micros. Timestamps are bounded through 2100. Storage byte-seconds commonly
exceed JavaScript's 2^53 safe-integer limit. The Rust implementation binds numeric
values as decimal strings and explicitly casts them to SQLite INTEGER rather
than passing lossy JavaScript floating-point values. Producers must likewise
preserve exact integers when constructing the event JSON; rounding in the
producer cannot be repaired by the ledger.

## Verification

Run `node --test scripts/tests/amail-usage.test.mjs`. The tests apply the actual
0001–0006 migration chain to SQLite, approve a real authorization fixture through
the binding trigger, and exercise exact 25,920,000,000,000,001 byte-seconds,
identical/conflicting replay, cumulative budget boundaries, missing approval,
negative quantities, overlapping periods, independent subsequent periods,
expired approval budgets, and immutable records. Rust tests additionally exercise
payload validation. `node --test scripts/tests/amail-authorizations.test.mjs`
extracts the production Rust INSERT and approval SQL, applies actual migrations,
and verifies creation idempotency, one-shot approval, atomic payer binding,
mismatched payer rollback, and proposal expiry.

## Historical consent and delayed event observations

Every usage event **requires** `authorization_id` (original immutable human receipt)
and `authorized_at` (resource admission time, UTC Unix seconds), including zero-charge
fractional carry records. `occurred_at` is the observation time, not a billing-period
membership test: stock rollover can occur exactly at period_end and provider acceptance
may be reconciled after period_end. It must be at least authorized_at/period_start and
no more than 300 seconds ahead of the service clock. Accounting remains on the original
nonoverlapping period.

Billing verifies that the receipt belongs to the owner, was approved by admission,
was not expired at admission, and was not superseded by any newer approved receipt before admission, including a USD approval superseding CNY. Receipt and event currency must match. All events for
one owner/currency/period share one cumulative liability sum; a historical event is bounded by
its original receipt's cap, not a separate fresh cap per authorization. Thus lowering
a cap prevents new spending but does not erase legitimate previously admitted backlog.
Accepted event retries remain deterministic even if later consent changes.

Real SQLite tests cover original-period stock at the boundary, late provider acceptance,
historical admission after entitlement expiry, cap decreases with old reservations,
new lower-cap denial, and prevention of quota reset through multiple receipts.

## USD cutover verification (local, 2026-10-07)

`node --test scripts/tests/amail-usd.test.mjs` applies real 0001–0004 SQL, creates
six CNY fixture events totaling exactly 22 micros, then applies additive 0006 and
compares every preexisting payload field. It extracts the current production Rust
INSERT, approval and summary SQL, not a mock. Tests prove all of the following:

- CNY history and consent denomination stay immutable; old pending CNY approval
  is blocked, and only explicit fresh USD approval replaces binding currency.
- USD spends its own complete cap without consuming the CNY sum; both summaries
  remain independent. Opposite-currency current caps are zero.
- Replay compares denomination; mismatched receipt/event currency is rejected.
- Currency-local overlap checks preserve legitimate CNY liability admitted before a
  USD approval; cross-currency receipt supersession denies new CNY admission after
  that approval, without granting dollar spending from yuan.
- Lowering a USD cap to zero preserves originally admitted USD backlog and rejects
  new admission, while the original six CNY events remain 22 CNY micros.

All 53 deployment/SQLite tests passed, including historical CNY lower-cap/expiry
coverage under the replaced 0006 triggers and the real pinned Wrangler splitter.
These fixture results are distinct from actual deployment and USD acceptance
recorded below; the earlier staging evidence remains accurately labeled CNY.

## Actual USD staging liability acceptance (2026-10-07)

Billing migration 0006 and source `86bb06e` deployed successfully in
[37641220454](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/37641220454).
[Controlled integrated run 37644087065](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37644087065)
then generated 14 actual excess address-seconds through normal CLI allocation and
retirement. All four task addresses were retired and the browser restored the
temporary $0.50 cap to zero before the normal five-minute Cron delivered two
events totaling 2 USD micros ($0.000002). No SQL event was seeded and no scheduler
was manually invoked. Explicit separate historical reads still returned exactly
6 CNY events / 22 CNY micros. Safe artifact `11494520444` contains aggregate
currency/amount/count evidence and retained actual usage-client/server ancestry
linked to one exact scheduled root.

The run's later Mail assertion still expected CNY, so the overall run failed
after successful authorization, metering and tracing. Fixing that harness must
not repeat charged usage: preserve the accrued USD amount and existing CNY
history, and exercise ordinary mail acceptance without metering confirmation.
Both denominations remain `pending_settlement`, not collected payments.

## Historical CNY staging liability acceptance (2026-10-07)

[Integrated Mail acceptance 37630962022](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37630962022)
passed against the existing staged Billing runtime `c77b7dd`. The normal browser
Manage UI approved a temporary 3 CNY ceiling for the protected synthetic identity;
normal CLI allocation/retirement generated seven real excess address-seconds and
seven new CNY micros. The UI restored zero budget before polling. Normal Cron,
not seeded SQL usage or a manual scheduler invocation, delivered the events.

[Final fixed readback 37634410400](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37634410400)
confirmed six immutable events and exactly 22 CNY micros in both Mail and Billing,
all outbox delivery markers present, zero current budget and zero registered
addresses. This includes three preserved earlier liabilities totaling 15 micros
that survived later consent reductions. All six actual retained Billing usage
server spans reported HTTP 200/success. Safe integration artifact `11486684051`
additionally proves actual human/CLI ancestry and successful asynchronous usage
client/server parentage linked to the separately retained scheduled root.

The initial Mail maintenance configuration lacked its required issuer; the
fixture had masked that mismatch. A maintenance-only staging repair plus
config-derived regression fixed the producer without redeploying Billing or
editing the preserved outbox. The ledger still reports `pending_settlement`;
none of this is a monetary payment receipt or automatic debit.


## Final ordinary USD mail acceptance

[37646418030](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37646418030)
completed **SUCCESS** with exact Mail candidate `aae6029` and successful producer
`37645057615` (CLI/Skill bundle `11493832761`). Safe artifact `11495350924` records
explicit USD Lite authorization, cancellation/return, authoritative CLI projection,
14 retained human/CLI spans and `grant_source=existing`. The journey also passed
actual SMTP/archive/search/read/delete, exact address/route cleanup and controlled
self-send receipt recovery/same-key replay/delivery-feedback/inbound. Metering
confirmation was deliberately omitted; the existing USD liability was not repeated.
The separate actual monetary/asynchronous proof remains artifact `11494520444`
from the earlier run `37644087065`, which is not relabeled overall successful.

[Final fixed readback 37646496526](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37646496526)
confirmed USD 2 micros / 2 events and unchanged CNY 22 micros / 6 events, all
outbox deliveries acknowledged, eight retained usage servers HTTP200/success,
zero current cap and zero registered addresses. No currency balance was converted,
combined or erased. Billing/Subscribe serving versions and runtime source `86bb06e`
remain unchanged by documentation commits. Settlement is still pending; no
production/Identity deployment or automatic monetary collection occurred.
