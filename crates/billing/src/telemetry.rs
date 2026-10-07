//! Closed, privacy-safe W3C server spans; request paths, identifiers and credentials are never logged.
use serde_json::json;
use worker::{Env, Request, Response, Result, wasm_bindgen::JsValue};

/// A sampled W3C parent, validated before accepting it across a trusted boundary.
#[derive(Clone)]
pub struct Parent {
    /// Nonzero lowercase hexadecimal trace identifier.
    pub trace_id: String,
    /// Nonzero lowercase hexadecimal parent span identifier.
    pub span_id: String,
}
/// Accepts only W3C version 00 with bounded hexadecimal identifiers and flags.
pub fn parse(value: &str) -> Option<Parent> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 4
        || parts[0] != "00"
        || !hex(parts[1], 32)
        || !hex(parts[2], 16)
        || parts[3].len() != 2
        || !parts[3]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    Some(Parent {
        trace_id: parts[1].into(),
        span_id: parts[2].into(),
    })
}
/// Trace identifiers deliberately disallow all-zero IDs and case-dependent representations.
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}
/// Generates runtime-only identifiers using OS/platform cryptographic randomness.
fn random_hex(size: usize) -> Result<String> {
    let mut bytes = vec![0u8; size];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| worker::Error::RustError("trace_random_unavailable".into()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
/// Generates an RFC 4122 UUIDv4 event identity without introducing another dependency.
fn event_id() -> Result<String> {
    let raw = random_hex(16)?;
    let variant = char::from(b"89ab"[u8::from_str_radix(&raw[16..17], 16).unwrap() as usize % 4]);
    Ok(format!(
        "{}-{}-4{}-{}{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[13..16],
        variant,
        &raw[17..20],
        &raw[20..]
    ))
}
/// Maps the finite service surface to stable labels, never logging paths or URL query parameters.
fn operation(path: &str, method: &worker::Method) -> &'static str {
    if path == "/v1/service/amail/authorizations" {
        "billing_session_create"
    } else if path.starts_with("/v1/service/amail/authorizations/") {
        "billing_session_status"
    } else if path.starts_with("/v1/authorizations/") && *method == worker::Method::Post {
        "billing_authorize"
    } else if path == "/v1/service/amail/usage" {
        "billing_usage_record"
    } else {
        "billing_status"
    }
}
/// Restored origins bridge the first browser hop; real same-trace client parents always win.
fn causal_parent(origin: Option<Parent>, caller: Option<Parent>) -> Option<Parent> {
    match (origin, caller) {
        (Some(origin), Some(caller)) if caller.trace_id == origin.trace_id => Some(caller),
        (Some(origin), _) => Some(origin),
        (None, caller) => caller,
    }
}
/// Emits one bounded server span; only authenticated dynamic callers may supply parent context.
pub async fn finish(
    request: &Request,
    response: &mut Response,
    started_at_ms: u64,
    env: &Env,
) -> Result<()> {
    let status = response.status_code();
    let path = request.path();
    let trusted = request.headers().get("x-billing-authenticated")?.as_deref() == Some("1");
    let inherited = response
        .headers()
        .get("x-amail-trace-context")?
        .and_then(|v| parse(&v));
    response.headers_mut().delete("x-amail-trace-context")?;
    let supplied = request
        .headers()
        .get("traceparent")?
        .and_then(|v| parse(&v));
    let parent = if trusted {
        causal_parent(inherited, supplied)
    } else {
        None
    };
    let trace_id = match &parent {
        Some(p) => p.trace_id.clone(),
        None => random_hex(16)?,
    };
    let span_id = random_hex(8)?;
    response
        .headers_mut()
        .set("traceparent", &format!("00-{trace_id}-{span_id}-01"))?;
    let outcome = if status >= 500 {
        "server_error"
    } else if status >= 400 {
        "client_error"
    } else {
        "success"
    };
    let record = json!({"schema_version":1,"event_id":event_id()?,"service":"billing",
        "operation":operation(&path,&request.method()),"phase":"request_exit","trace_id":trace_id,"span_id":span_id,
        "parent_span_id":parent.map(|p|p.span_id),"occurred_at_ms":started_at_ms,
        "duration_ms":worker::Date::now().as_millis().saturating_sub(started_at_ms),"outcome":outcome,"http_status":status});
    if path != "/v1/service/amail/trace-query" {
        let _ = persist(env, &record).await;
    }
    Ok(())
}
/// D1 receives only the closed envelope; persistence failure cannot invalidate a committed action.
async fn persist(env: &Env, record: &serde_json::Value) -> Result<()> {
    let db = env.d1("BILLING_DB")?;
    let fields = [
        "event_id",
        "schema_version",
        "service",
        "operation",
        "phase",
        "trace_id",
        "span_id",
        "parent_span_id",
        "occurred_at_ms",
        "duration_ms",
        "outcome",
        "http_status",
    ];
    let mut args: Vec<JsValue> = fields
        .iter()
        .map(|key| match &record[key] {
            serde_json::Value::String(v) => JsValue::from_str(v),
            serde_json::Value::Number(v) => JsValue::from_f64(v.as_f64().unwrap()),
            _ => JsValue::NULL,
        })
        .collect();
    args.push(JsValue::from_f64(
        (record["occurred_at_ms"].as_u64().unwrap() + 604_800_000) as f64,
    ));
    db.prepare("INSERT INTO billing_trace_spans(event_id,schema_version,service,operation,phase,trace_id,span_id,parent_span_id,occurred_at_ms,duration_ms,outcome,http_status,expires_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(event_id) DO NOTHING").bind(&args)?.run().await?;
    db.prepare("DELETE FROM billing_trace_spans WHERE event_id IN (SELECT event_id FROM billing_trace_spans WHERE expires_at_ms<?1 ORDER BY expires_at_ms LIMIT 128)")
        .bind(&[JsValue::from_f64(worker::Date::now().as_millis() as f64)])?.run().await?;
    Ok(())
}
/// Fixed service-only trace read; no arbitrary SQL filters, account lookups or raw provider metadata.
pub async fn query(request: &mut Request, env: &Env) -> Result<Response> {
    if request.url()?.query().is_some() {
        return crate::problem(
            400,
            "invalid_trace_query",
            "Use the fixed trace query endpoint",
        );
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        /// Exact nonzero lowercase W3C trace identifier.
        trace_id: String,
    }
    let input = match crate::read_json::<Input>(request).await {
        Ok(v) if hex(&v.trace_id, 32) => v,
        _ => return crate::problem(400, "invalid_trace_query", "Use a valid trace identifier"),
    };
    let spans=env.d1("BILLING_DB")?.prepare("SELECT event_id,schema_version,service,operation,phase,trace_id,span_id,parent_span_id,occurred_at_ms,duration_ms,outcome,http_status FROM billing_trace_spans WHERE trace_id=?1 AND expires_at_ms>?2 ORDER BY occurred_at_ms,event_id LIMIT 128")
        .bind(&[JsValue::from_str(&input.trace_id),JsValue::from_f64(worker::Date::now().as_millis() as f64)])?.all().await?.results::<serde_json::Value>()?;
    Response::from_json(&json!({"schema_version":1,"spans":spans}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_context_and_closed_operations() {
        assert!(parse("00-11111111111111111111111111111111-2222222222222222-01").is_some());
        assert!(parse("00-00000000000000000000000000000000-2222222222222222-01").is_none());
        assert!(parse("00-11111111111111111111111111111111-2222222222222222-01-secret").is_none());
        assert_eq!(
            operation("/v1/authorizations/SECRET/approve", &worker::Method::Post),
            "billing_authorize"
        );
    }
    #[test]
    fn restored_trace_preserves_the_actual_subscribe_client_span() {
        let origin = parse("00-11111111111111111111111111111111-2222222222222222-01");
        let caller = parse("00-11111111111111111111111111111111-3333333333333333-01");
        assert_eq!(
            causal_parent(origin.clone(), caller).unwrap().span_id,
            "3333333333333333"
        );
        let unrelated = parse("00-44444444444444444444444444444444-5555555555555555-01");
        assert_eq!(
            causal_parent(origin, unrelated).unwrap().span_id,
            "2222222222222222"
        );
    }
}
