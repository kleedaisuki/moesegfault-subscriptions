//! D1 constraints and a single trigger-backed redemption statement own concurrency.

use crate::{
    domain::{self, BillingProfile},
    problem,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{D1Database, D1PreparedStatement, Response, Result, wasm_bindgen::JsValue};

/// Public account data excludes issuer/subject, keeping the immutable principal mapping private.
#[derive(Debug, Serialize)]
pub struct Account {
    /// Random local account identifier.
    pub id: String,
    /// User-managed invoice and contact data.
    pub profile: BillingProfile,
    /// Account creation time in Unix seconds.
    pub created_at: i64,
    /// Most recent profile change time in Unix seconds.
    pub updated_at: i64,
}

/// Internal D1 account row stores JSON without leaking persistence details through the API.
#[derive(Deserialize)]
struct AccountRow {
    id: String,
    profile_json: String,
    created_at: i64,
    updated_at: i64,
}

/// Internal subscription representation; status is derived at read time rather than stale storage.
#[derive(Deserialize)]
struct SubscriptionRow {
    id: String,
    product_id: String,
    plan_id: String,
    current_period_start: i64,
    current_period_end: i64,
    entitlements_json: String,
    activation_source: String,
}

/// Stored idempotency result is immutable even if the subscription is extended later.
#[derive(Deserialize)]
struct RedemptionRow {
    request_hash: String,
    result_json: String,
}

/// Converts bound JSON primitives into JS values; query text is always static.
fn statement(db: &D1Database, sql: &str, values: &[Value]) -> Result<D1PreparedStatement> {
    let args: Vec<JsValue> = values
        .iter()
        .map(|v| match v {
            Value::String(v) => JsValue::from_str(v),
            Value::Number(v) => JsValue::from_f64(v.as_f64().unwrap()),
            Value::Null => JsValue::NULL,
            _ => unreachable!("SQL bindings are primitive"),
        })
        .collect();
    db.prepare(sql).bind(&args)
}

/// Creates the principal's account idempotently; uniqueness prevents parallel first-login duplicates.
pub async fn ensure_account(db: &D1Database, issuer: &str, subject: &str) -> Result<Account> {
    let now = domain::now();
    statement(db, "INSERT INTO billing_accounts(id,issuer,subject,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(issuer,subject) DO NOTHING",
        &[json!(domain::random_token()?),json!(issuer),json!(subject),json!(now)])?.run().await?;
    let row = statement(db, "SELECT id,profile_json,created_at,updated_at FROM billing_accounts WHERE issuer=?1 AND subject=?2",
        &[json!(issuer),json!(subject)])?.first::<AccountRow>(None).await?.ok_or_else(|| worker::Error::RustError("account_missing".into()))?;
    account(row)
}

/// Decodes validated stored account JSON; corruption is an operational failure, not an empty profile.
fn account(row: AccountRow) -> Result<Account> {
    Ok(Account {
        id: row.id,
        profile: serde_json::from_str(&row.profile_json)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// Replaces the profile atomically; only the authenticated account id is accepted.
pub async fn save_profile(db: &D1Database, id: &str, profile: &BillingProfile) -> Result<Account> {
    statement(
        db,
        "UPDATE billing_accounts SET profile_json=?2,updated_at=?3 WHERE id=?1",
        &[
            json!(id),
            json!(serde_json::to_string(profile)?),
            json!(domain::now()),
        ],
    )?
    .run()
    .await?;
    let row = statement(
        db,
        "SELECT id,profile_json,created_at,updated_at FROM billing_accounts WHERE id=?1",
        &[json!(id)],
    )?
    .first::<AccountRow>(None)
    .await?
    .ok_or_else(|| worker::Error::RustError("account_missing".into()))?;
    account(row)
}

/// Reads current subscription grants, calculating expiry at the runtime clock.
pub async fn subscriptions(db: &D1Database, account_id: &str) -> Result<Vec<Value>> {
    let rows = statement(
        db,
        "SELECT * FROM subscriptions WHERE account_id=?1 ORDER BY product_id",
        &[json!(account_id)],
    )?
    .all()
    .await?
    .results::<SubscriptionRow>()?;
    rows.into_iter().map(|s| Ok(json!({"id":s.id,"product_id":s.product_id,"plan_id":s.plan_id,
        "current_period_start":s.current_period_start,"current_period_end":s.current_period_end,
        "status":if s.current_period_end > domain::now() {"active"} else {"expired"},
        "activation_source":s.activation_source,"entitlements":serde_json::from_str::<Value>(&s.entitlements_json)?}))).collect()
}

/// Retrieves a durable retry result scoped to the same account and idempotency credential.
async fn replay(
    db: &D1Database,
    account_id: &str,
    key_hash: &str,
) -> Result<Option<RedemptionRow>> {
    statement(db, "SELECT request_hash,result_json FROM activation_redemptions WHERE account_id=?1 AND idempotency_key_hash=?2",
        &[json!(account_id),json!(key_hash)])?.first(None).await
}

/// Redeems a hashed one-use code atomically and returns an immutable stored grant result.
pub async fn activate(
    db: &D1Database,
    account_id: &str,
    code: &str,
    key: &str,
) -> Result<Response> {
    let request_hash = domain::hash(code);
    let key_hash = domain::hash(key);
    if let Some(result) = replay(db, account_id, &key_hash).await? {
        return replay_response(result, &request_hash, true);
    }
    let result = statement(db, "INSERT INTO activation_redemptions(code_hash,account_id,idempotency_key_hash,request_hash,redeemed_at,subscription_id) SELECT code_hash,?2,?3,?1,?4,?5 FROM activation_codes WHERE code_hash=?1 AND expires_at>?4 AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.account_id=?2 AND s.product_id=activation_codes.product_id AND s.current_period_end>?4 AND s.plan_id<>activation_codes.plan_id) ON CONFLICT DO NOTHING",
        &[json!(request_hash),json!(account_id),json!(key_hash),json!(domain::now()),json!(domain::random_token()?)])?.run().await?;
    let changed = result
        .meta()?
        .and_then(|m| m.changes)
        .is_some_and(|n| n > 0);
    match replay(db, account_id, &key_hash).await? {
        Some(result) => replay_response(result, &request_hash, !changed),
        None => {
            let conflict = statement(db, "SELECT 1 AS conflict FROM activation_codes c JOIN subscriptions s ON s.product_id=c.product_id WHERE c.code_hash=?1 AND c.expires_at>?3 AND s.account_id=?2 AND s.current_period_end>?3 AND s.plan_id<>c.plan_id AND NOT EXISTS(SELECT 1 FROM activation_redemptions r WHERE r.code_hash=c.code_hash)",
                &[json!(request_hash),json!(account_id),json!(domain::now())])?.first::<Value>(None).await?;
            if conflict.is_some() {
                return problem(
                    409,
                    "plan_conflict",
                    "Use this plan after your current subscription expires; the code has not been used",
                );
            }
            problem(
                409,
                "activation_code_unavailable",
                "This activation code is invalid, expired, or already used",
            )
        }
    }
}

/// Detects idempotency payload substitution and never grants again on replay.
fn replay_response(result: RedemptionRow, request_hash: &str, replayed: bool) -> Result<Response> {
    if result.request_hash != request_hash {
        return problem(
            409,
            "idempotency_conflict",
            "Start a new activation request",
        );
    }
    Response::from_json(
        &json!({"subscription":serde_json::from_str::<Value>(&result.result_json)?,"replayed":replayed}),
    )
}
