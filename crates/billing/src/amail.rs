//! Explicit human authorization bridges amail account ownership without changing pairwise subjects.
use crate::{domain, problem, repository};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use worker::{wasm_bindgen::JsValue, *};

/// A pending request contains proposed defaults only; approval records the human's actual choices.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    /// Opaque immutable amail owner key; never a contact identifier.
    owner_id: String,
    /// Stable reviewed plan identifier; no display-name inference.
    plan_id: String,
    /// Human spending ceiling in integer millionths of CNY.
    overage_budget_micros: i64,
    /// Exact deployment-allowlisted completion destination.
    return_url: String,
}
/// Explicit consent cannot be supplied by the agent's service credential.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    /// Explicit human consent after reviewing the displayed payer and tariff.
    acknowledge: bool,
    /// Stable reviewed plan identifier; no display-name inference.
    plan_id: String,
    /// Human spending ceiling in integer millionths of CNY.
    overage_budget_micros: i64,
}
/// Stored authorizations never contain bearer tokens or mutable contact identifiers.
#[derive(Deserialize, Serialize)]
struct Authorization {
    /// Random high-entropy authorization navigation handle.
    id: String,
    /// Opaque immutable amail owner key; never a contact identifier.
    owner_id: String,
    /// Canonical original machine payload hash for deterministic retries.
    request_hash: String,
    /// Stable reviewed plan identifier; no display-name inference.
    plan_id: String,
    /// Human spending ceiling in integer millionths of CNY.
    overage_budget_micros: i64,
    /// Exact deployment-allowlisted completion destination.
    return_url: String,
    /// Durable pending, approved or cancelled state.
    status: String,
    /// Verified Billing payer account, absent before human consent.
    account_id: Option<String>,
    /// Authoritative paid-grant expiry; null for perpetual Free access.
    valid_until: Option<i64>,
    /// Snapshot of deployment-owned entitlement identifiers.
    entitlements_json: String,
    /// Creation time in UTC Unix seconds.
    created_at: i64,
    /// Pending authorization deadline in UTC Unix seconds.
    expires_at: i64,
    /// Human approval time in UTC Unix seconds, if completed.
    approved_at: Option<i64>,
    /// Validated creation trace identifier; contains no account data.
    trace_id: Option<String>,
    /// Validated creation parent span for the browser handoff.
    parent_span_id: Option<String>,
}
/// The payer association is durable; subscription access still expires at the authoritative grant end.
#[derive(Deserialize)]
struct Binding {
    /// Opaque immutable amail owner key; never a contact identifier.
    owner_id: String,
    /// Verified Billing payer account, absent before human consent.
    account_id: String,
    /// Stable reviewed plan identifier; no display-name inference.
    plan_id: String,
    /// Human spending ceiling in integer millionths of CNY.
    overage_budget_micros: i64,
    /// Original consent receipt that established this binding.
    authorization_id: String,
    /// Authoritative paid-grant expiry; null for perpetual Free access.
    valid_until: Option<i64>,
    /// Snapshot of deployment-owned entitlement identifiers.
    entitlements_json: String,
    /// Last human-approved binding change in UTC Unix seconds.
    updated_at: i64,
}
/// Service identifiers are opaque, bounded URL-safe values, never email addresses or identity claims.
fn identifier(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
/// Restricts grants to the deployment's reviewed amail contract and a bounded CNY budget.
fn valid_choice(plan: &str, budget: i64) -> bool {
    matches!(plan, "amail-free" | "amail-lite" | "amail-plus")
        && (0..=1_000_000_000_000).contains(&budget)
}
/// Canonical UUIDv4 intents distinguish a new authorization from an uncertain HTTP retry.
fn valid_intent(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && b.iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}
/// Parameterized primitives only: no caller can supply SQL or a principal selector.
fn statement(db: &D1Database, sql: &str, args: &[Value]) -> Result<D1PreparedStatement> {
    let values: Vec<JsValue> = args
        .iter()
        .map(|v| match v {
            Value::String(s) => JsValue::from_str(s),
            Value::Number(n) => JsValue::from_f64(n.as_f64().unwrap()),
            Value::Null => JsValue::NULL,
            _ => unreachable!("primitive bindings only"),
        })
        .collect();
    db.prepare(sql).bind(&values)
}
/// The dedicated service secret authorizes only amail machine operations, not activation/admin issuance.
pub fn service_authenticated(request: &Request, env: &Env) -> bool {
    let Ok(key) = env.secret("AMAIL_SERVICE_KEY") else {
        return false;
    };
    let key = key.to_string();
    let presented = request
        .headers()
        .get("Authorization")
        .ok()
        .flatten()
        .unwrap_or_default();
    key.len() >= 32
        && bool::from(
            presented
                .as_bytes()
                .ct_eq(format!("Bearer {key}").as_bytes()),
        )
}
/// Loads one high-entropy authorization capability without accepting a caller-selected payer.
async fn authorization(db: &D1Database, id: &str) -> Result<Option<Authorization>> {
    statement(
        db,
        "SELECT * FROM amail_authorizations WHERE id=?1",
        &[json!(id)],
    )?
    .first(None)
    .await
}
/// Loads a binding by the opaque local amail account key, authenticated only at the service boundary.
async fn binding(db: &D1Database, owner: &str) -> Result<Option<Binding>> {
    statement(
        db,
        "SELECT * FROM amail_bindings WHERE owner_id=?1",
        &[json!(owner)],
    )?
    .first(None)
    .await
}
/// Projects an expired paid grant to Free without deleting the durable payer relationship.
fn binding_json(row: Binding) -> Result<Value> {
    let expired = row.valid_until.is_some_and(|until| until <= domain::now());
    Ok(
        json!({"owner_id":row.owner_id,"account_id":row.account_id,"product_id":"amail",
        "plan_id":if expired {"amail-free"} else {&row.plan_id},
        "overage_budget_micros":if expired {0} else {row.overage_budget_micros},
        "currency":"CNY","contract_version":"amail-v0.2.0","valid_until":row.valid_until,
        "entitlements":if expired {json!(["amail.plan.free"])} else {serde_json::from_str::<Value>(&row.entitlements_json)?},
        "authorization_id":row.authorization_id,"updated_at":row.updated_at}),
    )
}
/// Pending sessions expire without mutation; approved receipts remain readable for idempotent recovery.
fn authorization_json(row: &Authorization, expose_owner: bool) -> Value {
    let status = if row.status == "pending" && row.expires_at <= domain::now() {
        "expired"
    } else {
        &row.status
    };
    let mut value = json!({"id":row.id,"product_id":"amail","plan_id":row.plan_id,
        "overage_budget_micros":row.overage_budget_micros,"return_url":row.return_url,
        "status":status,"expires_at":row.expires_at,"approved_at":row.approved_at,
        "currency":"CNY","contract_version":"amail-v0.2.0"});
    if expose_owner {
        value["owner_id"] = json!(row.owner_id);
    }
    value
}
/// Public service responses never contain the OAuth principal or a browser bearer token.
async fn service_receipt(
    db: &D1Database,
    row: Authorization,
    restore_handoff: bool,
) -> Result<Response> {
    let linked = match binding(db, &row.owner_id).await? {
        Some(b) if b.authorization_id == row.id => Some(binding_json(b)?),
        _ => None,
    };
    let response = Response::from_json(
        &json!({"authorization":authorization_json(&row,true),"binding":linked,
        "settlement_mode":"activation_code_and_accrual"}),
    )?;
    if restore_handoff {
        trace_context(response, &row)
    } else {
        Ok(response)
    }
}
/// Restores the original safe creation trace across an explicit human browser handoff.
fn trace_context(mut response: Response, row: &Authorization) -> Result<Response> {
    if let (Some(trace), Some(parent)) = (&row.trace_id, &row.parent_span_id) {
        let value = format!("00-{trace}-{parent}-01");
        if crate::telemetry::parse(&value).is_some() {
            response
                .headers_mut()
                .set("x-amail-trace-context", &value)?;
        }
    }
    Ok(response)
}
/// Creates exactly one hosted consent intent per immutable service idempotency key.
async fn create(request: &mut Request, env: &Env, db: &D1Database) -> Result<Response> {
    let input: Create = match crate::read_json(request).await {
        Ok(v) => v,
        Err(_) => {
            return problem(
                400,
                "invalid_authorization",
                "Check the authorization request",
            );
        }
    };
    let key = request
        .headers()
        .get("Idempotency-Key")?
        .unwrap_or_default();
    if !valid_intent(&key) {
        return problem(
            400,
            "idempotency_key_required",
            "Use the original UUID authorization intent",
        );
    }
    let allowlist: Vec<String> =
        serde_json::from_str(&env.var("AMAIL_RETURN_URL_ALLOWLIST")?.to_string())?;
    if !identifier(&input.owner_id)
        || !valid_choice(&input.plan_id, input.overage_budget_micros)
        || !allowlist.contains(&input.return_url)
    {
        return problem(
            400,
            "invalid_authorization",
            "Check the authorization request",
        );
    }
    let request_hash = domain::hash(&serde_json::to_string(&input)?);
    let key_hash = domain::hash(&key);
    let now = domain::now();
    let parent = request
        .headers()
        .get("traceparent")?
        .and_then(|v| crate::telemetry::parse(&v));
    let trace_id = parent.as_ref().map(|p| p.trace_id.clone());
    let parent_span_id = parent.map(|p| p.span_id);
    statement(db,"INSERT INTO amail_authorizations(id,owner_id,idempotency_key_hash,request_hash,plan_id,overage_budget_micros,return_url,created_at,expires_at,trace_id,parent_span_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(owner_id,idempotency_key_hash) DO NOTHING",
        &[json!(domain::random_token()?),json!(input.owner_id),json!(key_hash),json!(request_hash),json!(input.plan_id),json!(input.overage_budget_micros),json!(input.return_url),json!(now),json!(now+1800),json!(trace_id),json!(parent_span_id)])?.run().await?;
    let row: Authorization = statement(
        db,
        "SELECT * FROM amail_authorizations WHERE owner_id=?1 AND idempotency_key_hash=?2",
        &[json!(input.owner_id), json!(key_hash)],
    )?
    .first(None)
    .await?
    .ok_or_else(|| Error::RustError("authorization_missing".into()))?;
    if row.request_hash != request_hash {
        return problem(
            409,
            "idempotency_conflict",
            "Retry the original authorization request",
        );
    }
    let origin = env.var("SUBSCRIBE_ORIGIN")?.to_string();
    Response::from_json(
        &json!({"authorization_id":row.id,"authorization_url":format!("{origin}/amail/authorize/{}",row.id),"expires_at":row.expires_at}),
    )
}
/// Machine operations are deliberately separate from browser OAuth operations.
pub async fn service_route(request: &mut Request, env: &Env, path: &str) -> Result<Response> {
    if !service_authenticated(request, env) {
        return problem(
            401,
            "invalid_service_key",
            "Service authentication required",
        );
    }
    request.headers_mut()?.set("x-billing-authenticated", "1")?;
    if path == "/v1/service/amail/trace-query" && request.method() == Method::Post {
        return crate::telemetry::query(request, env).await;
    }
    let db = env.d1("BILLING_DB")?;
    if path == "/v1/service/amail/authorizations" && request.method() == Method::Post {
        return create(request, env, &db).await;
    }
    if let Some(id) = path.strip_prefix("/v1/service/amail/authorizations/") {
        if request.method() == Method::Get && identifier(id) {
            return match authorization(&db, id).await? {
                Some(row) => service_receipt(&db, row, false).await,
                None => problem(404, "authorization_not_found", "Authorization not found"),
            };
        }
    }
    if let Some(owner) = path.strip_prefix("/v1/service/amail/accounts/") {
        if request.method() == Method::Get && identifier(owner) {
            return match binding(&db, owner).await? {
                Some(row) => Response::from_json(
                    &json!({"binding":binding_json(row)?,"settlement_mode":"activation_code_and_accrual"}),
                ),
                None => Response::from_json(
                    &json!({"binding":null,"settlement_mode":"activation_code_and_accrual"}),
                ),
            };
        }
    }
    if path == "/v1/service/amail/usage" || path.ends_with("/usage") {
        return crate::amail_usage::route(request, env, path).await;
    }
    problem(404, "not_found", "Not found")
}
/// Hosted operations require a validated Identity principal and explicit payer consent.
pub async fn browser_route(
    request: &mut Request,
    env: &Env,
    path: &str,
    issuer: &str,
    subject: &str,
) -> Result<Response> {
    let tail = path.strip_prefix("/v1/authorizations/").unwrap_or_default();
    let (id, action) = tail.split_once('/').unwrap_or((tail, ""));
    if !identifier(id) {
        return problem(404, "authorization_not_found", "Authorization not found");
    }
    let db = env.d1("BILLING_DB")?;
    let Some(row) = authorization(&db, id).await? else {
        return problem(404, "authorization_not_found", "Authorization not found");
    };
    let account = repository::ensure_account(&db, issuer, subject).await?;
    if row.account_id.as_ref().is_some_and(|id| id != &account.id) {
        return problem(
            403,
            "payer_mismatch",
            "Use the Billing account that authorized this request",
        );
    }
    let plans = domain::registry(env)?;
    let subscriptions = repository::subscriptions(&db, &account.id).await?;
    let subscription = subscriptions
        .iter()
        .find(|s| s["product_id"] == "amail" && s["status"] == "active");
    if request.method() == Method::Get && action.is_empty() {
        let plan = plans.iter().find(|p| p.id == row.plan_id);
        return trace_context(
            Response::from_json(
                &json!({"authorization":authorization_json(&row,false),"plan":plan,"subscription":subscription,
            "settlement_mode":"activation_code_and_accrual","requires_activation":row.plan_id != "amail-free" && subscription.is_none_or(|s| s["plan_id"] != row.plan_id)}),
            )?,
            &row,
        );
    }
    if request.method() != Method::Post || !matches!(action, "approve" | "cancel") {
        return problem(404, "not_found", "Not found");
    }
    let approval = if action == "approve" {
        match crate::read_json::<Approval>(request).await {
            Ok(v) if v.acknowledge && valid_choice(&v.plan_id, v.overage_budget_micros) => Some(v),
            _ => {
                return problem(
                    400,
                    "invalid_consent",
                    "Confirm the displayed plan and budget",
                );
            }
        }
    } else {
        None
    };
    if row.status != "pending" {
        return if row.status == "approved"
            && approval.as_ref().is_some_and(|a| {
                a.plan_id == row.plan_id && a.overage_budget_micros == row.overage_budget_micros
            }) {
            service_receipt(&db, row, true).await
        } else {
            problem(
                409,
                "authorization_closed",
                "This request is already closed",
            )
        };
    }
    if row.expires_at <= domain::now() {
        return problem(
            410,
            "authorization_expired",
            "Request a new authorization from amail",
        );
    }
    if action == "cancel" {
        statement(&db,"UPDATE amail_authorizations SET status='cancelled',account_id=?2 WHERE id=?1 AND status='pending'",&[json!(id),json!(account.id)])?.run().await?;
        return Response::from_json(&json!({"status":"cancelled"}));
    }
    let approval = approval.expect("approve action validated above");
    let Some(plan) = plans
        .iter()
        .find(|p| p.id == approval.plan_id && p.product_id == "amail" && p.active)
    else {
        return problem(400, "invalid_plan", "Choose an available amail plan");
    };
    let until = if approval.plan_id == "amail-free" {
        None
    } else {
        let Some(s) = subscription.filter(|s| s["plan_id"] == approval.plan_id) else {
            return problem(
                409,
                "activation_required",
                "Activate this plan before authorizing it",
            );
        };
        s["current_period_end"].as_i64()
    };
    if binding(&db, &row.owner_id)
        .await?
        .is_some_and(|b| b.account_id != account.id)
    {
        return problem(
            409,
            "payer_conflict",
            "This amail account is already linked to a different Billing payer",
        );
    }
    let update = statement(&db,"UPDATE amail_authorizations SET status='approved',account_id=?2,plan_id=?3,overage_budget_micros=?4,valid_until=?5,entitlements_json=?6,approved_at=?7 WHERE id=?1 AND status='pending' AND expires_at>?7",
        &[json!(id),json!(account.id),json!(approval.plan_id),json!(approval.overage_budget_micros),json!(until),json!(serde_json::to_string(&plan.entitlements)?),json!(domain::now())])?.run().await;
    if let Err(error) = update {
        if error.to_string().contains("amail_payer_conflict") {
            return problem(
                409,
                "payer_conflict",
                "This amail account is already linked to a different Billing payer",
            );
        }
        return Err(error);
    }
    service_receipt(
        &db,
        authorization(&db, id)
            .await?
            .ok_or_else(|| Error::RustError("authorization_missing".into()))?,
        true,
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_reviewed_plans_and_bounded_budgets() {
        assert!(valid_choice("amail-plus", 29_000_000));
        assert!(!valid_choice("platform-monthly", 0));
        assert!(!valid_choice("amail-free", -1));
        assert!(!valid_choice("amail-free", 1_000_000_000_001));
    }
    #[test]
    fn owners_are_opaque_not_contact_fields() {
        assert!(identifier("abc1234567890123456_-"));
        assert!(!identifier("klee@example.com"));
        assert!(!identifier("../other-account"));
    }
}
