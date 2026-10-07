//! Service-only amail usage ledger; acceptance records liability, not successful payment.

use crate::{amail::Currency, problem, read_json};
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{wasm_bindgen::JsValue, *};

/// Incoming immutable event; prices and incremental metering belong to amail.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Usage {
    /// Omitted old-wire denomination remains CNY for immutable historical retries.
    #[serde(default)]
    currency: Currency,
    /// Globally unique stable identifier retained across retries.
    event_id: String,
    /// Opaque amail principal previously bound through human authorization.
    owner_id: String,
    /// Inclusive start of a nonoverlapping accounting period, Unix seconds.
    period_start: i64,
    /// Exclusive end of the accounting period, Unix seconds.
    period_end: i64,
    /// One of the three billable resource dimensions.
    meter: String,
    /// Resource quantity, bounded to fit exact SQLite integer storage.
    quantity: i64,
    /// Incremental liability in millionths of the explicit event currency.
    amount_micros: i64,
    /// Event accounting timestamp inside the period.
    occurred_at: i64,
    /// Immutable human consent captured at resource admission, not the latest lower cap.
    authorization_id: String,
    /// Original admission time; provider reconciliation may observe acceptance much later.
    authorized_at: i64,
}

/// Limits identifier shape to opaque URL-safe tokens, never executable SQL or paths.
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}

impl Usage {
    /// Rejects negative, imprecise, unknown, and unbounded resource claims.
    fn valid(&self) -> bool {
        identifier(&self.event_id)
            && identifier(&self.owner_id)
            && (0..=4_102_444_800).contains(&self.period_start)
            && self.period_end > self.period_start
            && self.period_end <= 4_102_444_800
            && self.period_end - self.period_start <= 2_764_800
            && (self.period_start..=4_102_444_800).contains(&self.occurred_at)
            && identifier(&self.authorization_id)
            && (self.period_start..=self.occurred_at).contains(&self.authorized_at)
            && (0..=1_000_000_000_000_000_000).contains(&self.quantity)
            && (0..=1_000_000_000_000).contains(&self.amount_micros)
            && matches!(
                self.meter.as_str(),
                "outbound_recipients" | "storage_byte_seconds" | "address_seconds"
            )
    }
}

/// Current authorization budget is read only by the authenticated service route.
#[derive(Deserialize)]
struct Binding {
    /// Human-approved ceiling, not spendable credits or a payment receipt.
    overage_budget_micros: i64,
}

/// Aggregate query remains bounded to one owner and one period.
#[derive(Deserialize)]
struct Totals {
    /// Sum of accepted incremental charges.
    amount_micros: i64,
    /// Count of durable unique events.
    events_count: i64,
}

/// Binds strings so resource quantities above JavaScript's safe-integer limit stay exact.
fn statement(db: &D1Database, sql: &str, values: &[String]) -> Result<D1PreparedStatement> {
    db.prepare(sql).bind(
        &values
            .iter()
            .map(|v| JsValue::from_str(v))
            .collect::<Vec<_>>(),
    )
}

/// Routes requests after the caller has verified the machine credential.
pub async fn route(request: &mut Request, env: &Env, path: &str) -> Result<Response> {
    let db = env.d1("BILLING_DB")?;
    if request.method() == Method::Post && path == "/v1/service/amail/usage" {
        let event = match read_json::<Usage>(request).await {
            Ok(event) if event.valid() && event.occurred_at <= crate::domain::now() + 300 => event,
            _ => return problem(400, "invalid_usage", "Check usage event fields"),
        };
        return record(&db, event).await;
    }
    if request.method() == Method::Get {
        if let Some(owner) = path
            .strip_prefix("/v1/service/amail/accounts/")
            .and_then(|v| v.strip_suffix("/usage"))
        {
            let periods: Vec<_> = request
                .url()?
                .query_pairs()
                .filter(|(k, _)| k == "period_start")
                .map(|(_, v)| v.into_owned())
                .collect();
            let currencies: Vec<_> = request
                .url()?
                .query_pairs()
                .filter(|(k, _)| k == "currency")
                .map(|(_, v)| v.into_owned())
                .collect();
            let currency = match currencies.as_slice() {
                [] => Currency::Cny,
                [value] if value == "CNY" => Currency::Cny,
                [value] if value == "USD" => Currency::Usd,
                _ => {
                    return problem(
                        400,
                        "invalid_usage_currency",
                        "Select exactly one supported currency",
                    );
                }
            };
            let period = periods.first().and_then(|v| v.parse::<i64>().ok());
            if !identifier(owner)
                || periods.len() != 1
                || !period.is_some_and(|v| (0..=4_102_444_800).contains(&v))
            {
                return problem(
                    400,
                    "invalid_usage_period",
                    "Supply a valid accounting period",
                );
            }
            return summary(&db, owner, period.unwrap(), currency).await;
        }
    }
    problem(404, "not_found", "Not found")
}

/// Attempts one atomic write; SQL triggers arbitrate concurrent budget and retry races.
async fn record(db: &D1Database, event: Usage) -> Result<Response> {
    let values = vec![
        event.event_id.clone(),
        event.owner_id.clone(),
        event.period_start.to_string(),
        event.period_end.to_string(),
        event.meter.clone(),
        event.quantity.to_string(),
        event.amount_micros.to_string(),
        event.occurred_at.to_string(),
        event.authorization_id.clone(),
        event.authorized_at.to_string(),
        event.currency.code().into(),
    ];
    let inserted = statement(db, "INSERT INTO amail_usage_events(event_id,owner_id,period_start,period_end,meter,quantity,amount_micros,occurred_at,authorization_id,authorized_at,currency) VALUES(?1,?2,CAST(?3 AS INTEGER),CAST(?4 AS INTEGER),?5,CAST(?6 AS INTEGER),CAST(?7 AS INTEGER),CAST(?8 AS INTEGER),NULLIF(?9,''),CAST(?10 AS INTEGER),?11) ON CONFLICT(event_id) DO NOTHING", &values)?.run().await;
    let inserted = match inserted {
        Ok(result) => result,
        Err(error) => {
            let message = error.to_string();
            for (marker, code, title) in [
                (
                    "amail_consent_invalid",
                    "usage_consent_invalid",
                    "Use the original resource authorization receipt",
                ),
                (
                    "amail_binding_required",
                    "authorization_required",
                    "Authorize amail billing first",
                ),
                (
                    "amail_event_conflict",
                    "usage_event_conflict",
                    "Event identifier already has different usage",
                ),
                (
                    "amail_period_conflict",
                    "usage_period_conflict",
                    "Accounting periods must not overlap",
                ),
                (
                    "amail_budget_exceeded",
                    "overage_budget_exceeded",
                    "Usage exceeds the authorized budget",
                ),
            ] {
                if message.contains(marker) {
                    return problem(409, code, title);
                }
            }
            return Err(error);
        }
    };
    let replayed = inserted.meta()?.and_then(|meta| meta.changes) == Some(0);
    Response::from_json(&json!({"event_id":event.event_id,"owner_id":event.owner_id,
        "currency":event.currency,"amount_micros":event.amount_micros,"settlement_status":"pending_settlement","replayed":replayed}))
}

/// Returns liabilities without exposing account identities, credentials, or paid-success claims.
async fn summary(
    db: &D1Database,
    owner: &str,
    period: i64,
    currency: Currency,
) -> Result<Response> {
    let binding = statement(
        db,
        "SELECT CASE WHEN currency != ?2 OR (valid_until IS NOT NULL AND valid_until <= unixepoch()) THEN 0 ELSE overage_budget_micros END AS overage_budget_micros FROM amail_bindings WHERE owner_id=?1",
        &[owner.into(), currency.code().into()],
    )?
    .first::<Binding>(None)
    .await?;
    let Some(binding) = binding else {
        return problem(
            404,
            "authorization_required",
            "Authorize amail billing first",
        );
    };
    let totals = statement(db, "SELECT COALESCE(SUM(amount_micros),0) AS amount_micros,COUNT(*) AS events_count FROM amail_usage_events WHERE owner_id=?1 AND period_start=CAST(?2 AS INTEGER) AND currency=?3", &[owner.into(), period.to_string(), currency.code().into()])?
        .first::<Totals>(None).await?.ok_or_else(|| Error::RustError("usage_aggregate_missing".into()))?;
    let payload: Value = json!({"owner_id":owner,"period_start":period,"currency":currency,"amount_micros":totals.amount_micros,
        "overage_budget_micros":binding.overage_budget_micros,"settlement_status":"pending_settlement","events_count":totals.events_count});
    Response::from_json(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Storage metering must accept exact integer quantities beyond 2^53.
    #[test]
    fn validates_bounded_resource_events() {
        let mut event: Usage =
            serde_json::from_value(json!({"event_id":"event-1", "owner_id":"owner-1",
            "period_start":100,"period_end":200,"occurred_at":150,"meter":"storage_byte_seconds",
            "quantity":25_920_000_000_000_000_i64,"amount_micros":1,
            "authorization_id":"original-approval","authorized_at":140}))
            .unwrap();
        assert!(event.valid());
        assert_eq!(event.currency, Currency::Cny);
        event.currency = Currency::Usd;
        assert!(event.valid());
        event.amount_micros = -1;
        assert!(!event.valid());
        event.amount_micros = 1;
        event.period_end = 100;
        assert!(!event.valid());
        event.period_end = 200;
        event.meter = "searches".into();
        assert!(!event.valid());
    }
}
