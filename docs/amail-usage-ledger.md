# amail service usage ledger

The amail machine route authenticates before calling `amail_usage::route`. It can
write usage only for an owner with a human-approved Billing binding. The API does
not accept a caller-selected Billing account ID and never joins accounts by email
or alternate Identity subjects.

## Contract

`POST /v1/service/amail/usage` takes an immutable event with `event_id`, `owner_id`,
`period_start`, `period_end`, `meter`, `quantity`, `amount_micros`, and `occurred_at`.
Meters are `outbound_recipients`, `storage_byte_seconds`, and `address_seconds`.
Amounts are integer millionths of CNY. amail owns incremental metering, included
allowances, price calculations, and period selection; Billing owns durable
acceptance and aggregate budget enforcement. Periods must not overlap for a given
owner, cannot exceed 32 days, and include the event timestamp. A repeated event ID
with an identical payload is a successful no-op; changing any field is a 409.

The response includes `event_id`, `owner_id`, `amount_micros`, and
`settlement_status: "pending_settlement"`, and `replayed` (derived from the atomic
write's affected-row count). This is **not** a payment receipt,
credit balance, or claim that a charge has settled. No monetary payment provider
is invoked by this ledger.

`GET /v1/service/amail/accounts/{owner}/usage?period_start=...` returns
`owner_id`, `period_start`, `amount_micros`, `overage_budget_micros`,
`settlement_status`, and `events_count`. Unknown owners return 404.

## Persistence and integer accuracy

Migration `0004_amail_usage.sql` enforces cumulative period charges against the
binding's current budget in a BEFORE INSERT trigger. This executes atomically
under SQLite's writer lock, so parallel writes cannot each spend the same budget.
Budget changes do not erase existing liabilities. Expired paid bindings expose a
zero budget and cannot accrue new charges; accepted identical retries remain
available after expiry. UPDATE and DELETE are blocked.
Immutable event payload comparisons happen in SQL as well, including concurrent
retries. Query and index scope is always owner plus period.

The accepted quantity bound is 10^18; amounts and binding budgets are bounded by
10^12 micros. Timestamps are bounded through 2100. Storage byte-seconds commonly
exceed JavaScript's 2^53 safe-integer limit. The Rust implementation binds numeric
values as decimal strings and explicitly casts them to SQLite INTEGER rather
than passing lossy JavaScript floating-point values. Producers must likewise
preserve exact integers when constructing the event JSON; rounding in the
producer cannot be repaired by the ledger.

## Verification

Run `node --test scripts/tests/amail-usage.test.mjs`. The tests apply the actual
0001–0004 migration chain to SQLite, approve a real authorization fixture through
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
was not expired at admission, and was not superseded before admission. All events for
one owner/period share one cumulative liability sum; a historical event is bounded by
its original receipt's cap, not a separate fresh cap per authorization. Thus lowering
a cap prevents new spending but does not erase legitimate previously admitted backlog.
Accepted event retries remain deterministic even if later consent changes.

Real SQLite tests cover original-period stock at the boundary, late provider acceptance,
historical admission after entitlement expiry, cap decreases with old reservations,
new lower-cap denial, and prevention of quota reset through multiple receipts.
