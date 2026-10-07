//! Subscribe's same-origin BFF: opaque browser sessions and server-held OAuth tokens.
mod crypto;
mod oidc;
mod policy;
mod store;

use billing::auth::{ValidationPolicy, verify_token};
use serde_json::json;
use subtle::ConstantTimeEq;
use wasm_bindgen::JsValue;
use worker::*;

/// Covers bounded Identity registration: initial mail request, renewed challenge and proof.
/// This is an unauthenticated transaction deadline, never an access-token/session lifetime.
const PREAUTH_TTL_SECONDS: i64 = 30 * 60;

/// Cloudflare entrypoint. Internal failures deliberately reveal no credentials or provider body.
#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let mut req = req.clone_mut()?;
    let started = Date::now().as_millis();
    let incoming_parent = req.headers().get("traceparent")?;
    let stored_parent = authorization_context(&env, &req.path(), req.method(), started)
        .await
        .ok()
        .flatten();
    let parent = preferred_trace_parent(stored_parent, incoming_parent);
    let parent_span = parent
        .as_deref()
        .filter(|value| valid_traceparent(value))
        .map(|value| value[36..52].to_string());
    let trace = trace_context(parent.as_deref())?;
    req.headers_mut()?.set("traceparent", &trace)?;
    let correlation = crypto::random()?;
    let path = req.path();
    let dynamic = path.starts_with("/api/")
        || path.starts_with("/auth/")
        || path == "/healthz"
        || path.starts_with("/amail/authorize/");
    let operation = telemetry_operation(&path);
    let trace_query = path == "/v1/service/amail/trace-query";
    let result = route(req, &env).await;
    let mut response = match result {
        Ok(response) => response,
        Err(Error::RustError(message)) if message == "ambiguous parameter" => {
            problem(400, "invalid_parameters", "Invalid request parameters.")?
        }
        Err(_) => problem(503, "service_unavailable", "Please try again shortly.")?,
    };
    if response
        .headers()
        .get("x-moesegfault-correlation-id")?
        .is_none()
    {
        response
            .headers_mut()
            .set("x-moesegfault-correlation-id", &correlation)?;
    }
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    response
        .headers_mut()
        .set("Referrer-Policy", "no-referrer")?;
    if dynamic || response.status_code() >= 300 {
        response.headers_mut().set("Cache-Control", "no-store")?;
    }
    response.headers_mut().set("traceparent", &trace)?;
    if !trace_query {
        let _ = TelemetrySpan {
            operation,
            phase: "request_exit",
            trace: &trace,
            parent_span: parent_span.as_deref(),
            started,
        }
        .emit(&env, response.status_code())
        .await;
    }
    let account = env.var("ACCOUNT_ORIGIN")?.to_string();
    let parsed = url::Url::parse(&account)?;
    if parsed.scheme() != "https" || parsed.origin().ascii_serialization() != account {
        return problem(503, "configuration_error", "Service unavailable.");
    }
    response.headers_mut().set("Content-Security-Policy",&format!("default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' {account}"))?;
    Ok(response)
}

/// Dispatch a deliberately small API surface; caller-supplied identity headers are never forwarded.
async fn route(mut req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let path = url.path();
    let now = Date::now().as_millis() as i64 / 1000;
    let app = env.var("APP_ORIGIN")?.to_string();
    if url.origin().ascii_serialization() != app {
        return problem(400, "invalid_origin", "Invalid request origin.");
    }
    if path == "/v1/service/amail/trace-query" {
        return trace_query(&mut req, env).await;
    }
    if path == "/healthz" {
        return Response::from_json(&json!({"status":"ok"}));
    }
    if req.method() == Method::Get && path == "/auth/login" {
        return login(&req, env, now).await;
    }
    if req.method() == Method::Get && path == "/auth/callback" {
        return match callback(&req, env, now).await {
            Ok(response) => Ok(response),
            Err(_) => login_failure(env, None, None, "login_failed"),
        };
    }
    if req.method() == Method::Get && path == "/api/catalog" {
        return proxy(&mut req, env, None, "/v1/plans").await;
    }
    if !path.starts_with("/api/") && !path.starts_with("/auth/") {
        if path == "/account" && query(&url, "reconnect")? == Some("1".into()) {
            return redirect(&format!("{app}/auth/login?path=/account"));
        }
        let response = env
            .get_binding::<Fetcher>("ASSETS")?
            .fetch_request(req)
            .await?;
        // Fetched response headers are immutable. workers-rs Headers::clone constructs
        // new platform Headers, retaining cache metadata without buffering the body.
        let headers = response.headers().clone();
        return Ok(response.with_headers(headers));
    }
    let session = store::session(&req, env, now).await?;
    if req.method() == Method::Get && path == "/api/session" {
        let incoming = query(&url, "return_to")?;
        let allowlist: Vec<String> =
            serde_json::from_str(&env.var("RETURN_URL_ALLOWLIST")?.to_string())?;
        if incoming
            .as_ref()
            .is_some_and(|v| !policy::return_allowed(v, &allowlist))
        {
            return problem(400, "invalid_return_url", "Invalid destination.");
        }
        return Response::from_json(&match session {
            None => json!({"authenticated":false}),
            Some(s) => {
                json!({"authenticated":true,"csrfToken":s.csrf,"user":{"sub":s.subject,"name":s.name},"returnTo":incoming.or(s.return_to)})
            }
        });
    }
    let Some(session) = session else {
        return problem(401, "authentication_required", "Sign in to continue.");
    };
    if req.method() != Method::Get && !csrf_valid(&req, &app, &session.csrf)? {
        return problem(403, "csrf_failed", "Refresh this page and try again.");
    }
    if let Some(upstream) = amail_authorization_path(path, req.method()) {
        return proxy(&mut req, env, Some(&session), &upstream).await;
    }
    match (req.method(), path) {
        (Method::Get, "/api/billing") => proxy(&mut req, env, Some(&session), "/v1/me").await,
        (Method::Put, "/api/profile") => {
            proxy(&mut req, env, Some(&session), "/v1/me/profile").await
        }
        (Method::Post, "/api/activate") => {
            proxy(&mut req, env, Some(&session), "/v1/activations").await
        }
        (Method::Post, "/auth/logout") => {
            env.d1("SESSIONS")?
                .prepare("DELETE FROM subscribe_sessions WHERE session_hash=?1")
                .bind(&[session.session_hash.into()])?
                .run()
                .await?;
            let mut response = Response::from_json(&json!({"ok":true}))?;
            response
                .headers_mut()
                .append("Set-Cookie", &session_cookie("", 0))?;
            Ok(response)
        }
        _ => problem(404, "not_found", "Not found."),
    }
}

/// Raw request metadata is never persisted; closed typed spans expire after seven days.
const TRACE_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Exact JSON shape prevents trace-query inputs from smuggling arbitrary log attributes.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceQuery {
    /// Nonzero lowercase 128-bit W3C identifier, never a capability URL.
    trace_id: String,
}

/// Validate the fixed trace query independently of browser or JavaScript runtime bindings.
fn trace_query_valid(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}

/// Service-only bounded retrieval; no cookies, browser sessions or self-observing writes.
async fn trace_query(req: &mut Request, env: &Env) -> Result<Response> {
    let key = env
        .secret("AMAIL_SERVICE_KEY")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let presented = req.headers().get("Authorization")?.unwrap_or_default();
    if key.len() < 32
        || !bool::from(
            presented
                .as_bytes()
                .ct_eq(format!("Bearer {key}").as_bytes()),
        )
    {
        return problem(
            401,
            "authentication_required",
            "Service authentication required.",
        );
    }
    if req.method() != Method::Post || req.url()?.query().is_some() {
        return problem(400, "invalid_trace_query", "Invalid trace query.");
    }
    if req
        .headers()
        .get("Content-Type")?
        .as_deref()
        .is_none_or(|value| value.split(';').next() != Some("application/json"))
    {
        return problem(415, "unsupported_media_type", "Use JSON.");
    }
    use futures_util::StreamExt;
    let mut stream = req.stream()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 256 {
            return problem(413, "body_too_large", "Request is too large.");
        }
        bytes.extend_from_slice(&chunk);
    }
    let Ok(query) = serde_json::from_slice::<TraceQuery>(&bytes) else {
        return problem(400, "invalid_trace_query", "Invalid trace query.");
    };
    if !trace_query_valid(&query.trace_id) {
        return problem(400, "invalid_trace_query", "Invalid trace query.");
    }
    let spans = env.d1("SESSIONS")?.prepare("SELECT schema_version,event_id,service,operation,phase,trace_id,span_id,parent_span_id,occurred_at_ms,duration_ms,outcome,http_status FROM subscribe_trace_spans WHERE trace_id=?1 AND expires_at_ms>?2 ORDER BY occurred_at_ms,event_id LIMIT 128")
        .bind(&[query.trace_id.into(), JsValue::from_f64(Date::now().as_millis() as f64)])?
        .all().await?.results::<serde_json::Value>()?;
    let mut response = Response::from_json(&json!({"schema_version":1,"spans":spans}))?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

/// Handoff continuity is server-owned and bounded independently of subscription lifetimes.
const AUTHORIZATION_TRACE_TTL_MS: u64 = 30 * 60 * 1000;

/// Stored Billing context wins over a browser-provided root, but malformed state never propagates.
fn preferred_trace_parent(stored: Option<String>, incoming: Option<String>) -> Option<String> {
    stored
        .filter(|value| valid_traceparent(value))
        .or_else(|| incoming.filter(|value| valid_traceparent(value)))
}

/// Return an ID only for the fixed authorization lookup, never nested action or unrelated routes.
fn upstream_authorization_id(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/authorizations/")
        .filter(|id| authorization_id_valid(id))
}

/// Reads only a hashed capability key and a typed W3C context, never account or bearer material.
async fn authorization_context(
    env: &Env,
    path: &str,
    method: Method,
    now: u64,
) -> Result<Option<String>> {
    let Some(upstream) = amail_authorization_path(path, method) else {
        return Ok(None);
    };
    let id = upstream
        .strip_prefix("/v1/authorizations/")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let row: Option<serde_json::Value> = env.d1("SESSIONS")?
        .prepare("SELECT traceparent FROM subscribe_authorization_traces WHERE authorization_hash=?1 AND expires_at_ms>?2")
        .bind(&[crypto::hash(id).into(), JsValue::from_f64(now as f64)])?.first(None).await?;
    Ok(row
        .and_then(|value| value["traceparent"].as_str().map(str::to_string))
        .filter(|value| valid_traceparent(value)))
}

/// Authenticated successful Billing lookups establish the next request's real trace ancestry.
async fn store_authorization_context(env: &Env, id: &str, context: &str) -> Result<()> {
    let now = Date::now().as_millis();
    let db = env.d1("SESSIONS")?;
    db.batch(vec![
        db.prepare("DELETE FROM subscribe_authorization_traces WHERE authorization_hash IN (SELECT authorization_hash FROM subscribe_authorization_traces WHERE expires_at_ms<=?1 LIMIT 128)").bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("INSERT INTO subscribe_authorization_traces(authorization_hash,traceparent,expires_at_ms) VALUES(?1,?2,?3) ON CONFLICT(authorization_hash) DO UPDATE SET traceparent=excluded.traceparent,expires_at_ms=excluded.expires_at_ms")
            .bind(&[crypto::hash(id).into(), context.into(), JsValue::from_f64((now + AUTHORIZATION_TRACE_TTL_MS) as f64)])?,
    ]).await?;
    Ok(())
}

/// Closed event metadata: no URLs, bodies, accounts or authorization identifiers can be added.
struct TelemetrySpan<'a> {
    /// Finite, privacy-safe label selected by the service router.
    operation: &'static str,
    /// Span boundary classification, either request_exit or dependency_exit.
    phase: &'static str,
    /// Valid W3C context containing the real trace and current span identity.
    trace: &'a str,
    /// Valid incoming span identity, absent only for a root span.
    parent_span: Option<&'a str>,
    /// UTC Unix milliseconds captured at span entry.
    started: u64,
}

impl TelemetrySpan<'_> {
    /// Build the shared schema deterministically for privacy and outcome contract tests.
    fn record(&self, event_id: &str, finished: u64, status: u16) -> serde_json::Value {
        let outcome = if status >= 500 {
            "server_error"
        } else if status >= 400 {
            "client_error"
        } else {
            "success"
        };
        json!({"schema_version":1,"event_id":event_id,"service":"subscribe",
            "operation":self.operation,"phase":self.phase,"trace_id":&self.trace[3..35],
            "span_id":&self.trace[36..52],"parent_span_id":self.parent_span,
            "occurred_at_ms":self.started,"duration_ms":finished.saturating_sub(self.started),
            "outcome":outcome,"http_status":status})
    }

    /// Emit an independently identifiable closed span, never arbitrary structured log fields.
    async fn emit(&self, env: &Env, status: u16) -> Result<()> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes)
            .map_err(|_| Error::RustError("entropy unavailable".into()))?;
        let finished = Date::now().as_millis();
        let record = self.record(&telemetry_event_id(bytes), finished, status);
        let fields = [
            "schema_version",
            "event_id",
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
        let mut values: Vec<JsValue> = fields
            .iter()
            .map(|key| {
                let value = &record[key];
                if let Some(text) = value.as_str() {
                    JsValue::from_str(text)
                } else if let Some(number) = value.as_u64() {
                    JsValue::from_f64(number as f64)
                } else {
                    JsValue::NULL
                }
            })
            .collect();
        values.push(JsValue::from_f64(
            (self.started + TRACE_RETENTION_MS) as f64,
        ));
        let db = env.d1("SESSIONS")?;
        db.batch(vec![
            db.prepare("DELETE FROM subscribe_trace_spans WHERE event_id IN (SELECT event_id FROM subscribe_trace_spans WHERE expires_at_ms<=?1 LIMIT 128)").bind(&[JsValue::from_f64(finished as f64)])?,
            db.prepare("INSERT INTO subscribe_trace_spans(schema_version,event_id,service,operation,phase,trace_id,span_id,parent_span_id,occurred_at_ms,duration_ms,outcome,http_status,expires_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)").bind(&values)?,
        ]).await?;
        Ok(())
    }
}

/// Format cryptographic random bytes into an RFC 4122 UUIDv4 identity.
fn telemetry_event_id(mut bytes: [u8; 16]) -> String {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// Restrict W3C propagation to version 00 with nonzero lowercase hexadecimal identifiers.
fn valid_traceparent(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    parts.len() == 4
        && parts[0] == "00"
        && parts[1].len() == 32
        && parts[2].len() == 16
        && parts[3].len() == 2
        && parts[1..].iter().all(|part| {
            part.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        && parts[1].bytes().any(|b| b != b'0')
        && parts[2].bytes().any(|b| b != b'0')
}

/// Each boundary owns a fresh span; caller-controlled baggage is deliberately not forwarded.
fn trace_context(parent: Option<&str>) -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::RustError("entropy unavailable".into()))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let parent = parent.filter(|value| valid_traceparent(value));
    let trace = parent.map(|value| &value[3..35]).unwrap_or(&hex[..32]);
    Ok(format!("00-{trace}-{}-01", &hex[32..]))
}

/// Telemetry labels never contain authorization identifiers, OAuth codes, or query strings.
fn telemetry_operation(path: &str) -> &'static str {
    if path.starts_with("/api/amail/authorizations/") || path.starts_with("/v1/authorizations/") {
        return if path.ends_with("/approve") {
            "amail.authorization.approve"
        } else if path.ends_with("/cancel") {
            "amail.authorization.cancel"
        } else {
            "amail.authorization.get"
        };
    }
    if path.starts_with("/amail/authorize/") {
        return "amail.authorization.page";
    }
    match path {
        "/auth/login" => "auth.login",
        "/auth/callback" => "auth.callback",
        "/api/activate" | "/v1/activations" => "billing.activate",
        "/api/billing" | "/v1/me" => "billing.account",
        "/api/session" => "session.get",
        "/auth/logout" => "session.logout",
        _ => "subscribe.other",
    }
}

/// Only the fixed hosted prefix followed by one opaque segment can survive login.
fn hosted_authorization_path(path: &str) -> bool {
    path.strip_prefix("/amail/authorize/")
        .is_some_and(authorization_id_valid)
}

/// Opaque authorization identifiers cannot introduce another path or query component.
fn authorization_id_valid(id: &str) -> bool {
    (24..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Explicit browser routes never become a general authenticated Billing proxy.
fn amail_authorization_path(path: &str, method: Method) -> Option<String> {
    let suffix = path.strip_prefix("/api/amail/authorizations/")?;
    let (id, action) = suffix.split_once('/').unwrap_or((suffix, ""));
    if !authorization_id_valid(id) {
        return None;
    }
    match (method, action) {
        (Method::Get, "") | (Method::Post, "approve" | "cancel") => {
            Some(format!("/v1/authorizations/{suffix}"))
        }
        _ => None,
    }
}

/// Create browser-bound PKCE state; external continuation is data for the UI, never callback redirect.
async fn login(req: &Request, env: &Env, now: i64) -> Result<Response> {
    let url = req.url()?;
    let path = query(&url, "path")?.unwrap_or_else(|| "/".into());
    if !matches!(path.as_str(), "/" | "/account") && !hosted_authorization_path(&path) {
        return problem(400, "invalid_return_path", "Invalid destination.");
    }
    let return_to = query(&url, "return_to")?;
    let allowlist: Vec<String> =
        serde_json::from_str(&env.var("RETURN_URL_ALLOWLIST")?.to_string())?;
    if return_to
        .as_ref()
        .is_some_and(|v| !policy::return_allowed(v, &allowlist))
    {
        return problem(400, "invalid_return_url", "Invalid destination.");
    }
    let mut destination = url::Url::parse(&format!("{}{}", env.var("APP_ORIGIN")?, path))?;
    for key in ["locale", "theme"] {
        if let Some(value) = query(&url, key)? {
            if !matches!(
                (key, value.as_str()),
                ("locale", "zh-CN" | "en" | "ja") | ("theme", "light" | "dark")
            ) {
                return problem(400, "invalid_preference", "Invalid preference.");
            }
            destination.query_pairs_mut().append_pair(key, &value);
        }
    }
    for key in ["app", "plan"] {
        if let Some(value) = query(&url, key)? {
            if value.is_empty()
                || value.len() > 128
                || !value.bytes().all(|b| (33..=126).contains(&b))
            {
                return problem(400, "invalid_context", "Invalid subscription request.");
            }
            destination.query_pairs_mut().append_pair(key, &value);
        }
    }
    let local_path = format!(
        "{}{}",
        destination.path(),
        destination
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default()
    );
    let discovery = oidc::discover(env).await?;
    let state = crypto::random()?;
    let browser = crypto::random()?;
    let nonce = crypto::random()?;
    let verifier = crypto::random()?;
    let db = env.d1("SESSIONS")?;
    db.batch(vec![
        db.prepare("DELETE FROM subscribe_login WHERE expires_at<=?1").bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("DELETE FROM subscribe_sessions WHERE expires_at<=?1").bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("INSERT INTO subscribe_login(state_hash,browser_hash,nonce,verifier,return_to,local_path,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)")
            .bind(&[crypto::hash(&state).into(),crypto::hash(&browser).into(),nonce.clone().into(),verifier.clone().into(),return_to.map(JsValue::from).unwrap_or(JsValue::NULL),local_path.into(),JsValue::from_f64((now+PREAUTH_TTL_SECONDS) as f64)])?,
    ]).await?;
    let mut authorize = url::Url::parse(&discovery.authorization_endpoint)?;
    authorize.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &env.var("CLIENT_ID")?.to_string()),
        (
            "redirect_uri",
            &format!("{}/auth/callback", env.var("APP_ORIGIN")?),
        ),
        ("scope", "openid profile"),
        ("state", &state),
        ("nonce", &nonce),
        ("code_challenge", &crypto::hash(&verifier)),
        ("code_challenge_method", "S256"),
    ]);
    let mut response = redirect(authorize.as_str())?;
    response
        .headers_mut()
        .append("Set-Cookie", &login_cookie(&browser, PREAUTH_TTL_SECONDS))?;
    Ok(response)
}

/// Consume state atomically, verify both token kinds, and create a bounded application session.
async fn callback(req: &Request, env: &Env, now: i64) -> Result<Response> {
    let url = req.url()?;
    let Some(state) = query(&url, "state")? else {
        return login_failure(env, None, None, "login_failed");
    };
    let Some(browser) = store::cookie(req, "__Host-subscribe-login")? else {
        return login_failure(env, None, None, "login_failed");
    };
    if query(&url, "iss")? != Some(env.var("ISSUER")?.to_string()) {
        return login_failure(env, None, None, "login_failed");
    }
    let Some(tx) = store::consume(env, &state, &browser, now).await? else {
        return login_failure(env, None, None, "login_failed");
    };
    if query(&url, "error")?.is_some() {
        return login_failure(
            env,
            Some(&tx.local_path),
            tx.return_to.as_deref(),
            "login_denied",
        );
    }
    match finish_callback(req, env, now, &tx).await {
        Ok(response) if response.status_code() < 400 => Ok(response),
        _ => login_failure(
            env,
            Some(&tx.local_path),
            tx.return_to.as_deref(),
            "login_failed",
        ),
    }
}

/// Complete a consumed transaction; failures are converted to a safe product-page recovery.
async fn finish_callback(
    req: &Request,
    env: &Env,
    now: i64,
    tx: &store::Login,
) -> Result<Response> {
    let url = req.url()?;
    let Some(code) = query(&url, "code")? else {
        return problem(400, "invalid_callback", "Sign in again.");
    };
    let discovery = oidc::discover(env).await?;
    let tokens = oidc::exchange(env, &discovery.token_endpoint, &code, &tx.verifier, now).await?;
    let mut policy = ValidationPolicy {
        issuer: discovery.issuer,
        audiences: vec![env.var("CLIENT_ID")?.to_string()],
        token_use: "id".into(),
        nonce: Some(tx.nonce.clone()),
        required_scope: None,
    };
    let Ok(principal) = verify_token(&tokens.id_token, env, &policy).await else {
        return problem(401, "invalid_identity_token", "Sign in again.");
    };
    policy.token_use = "access".into();
    policy.nonce = None;
    policy.required_scope = Some("openid".into());
    let Ok(access) = verify_token(&tokens.access_token, env, &policy).await else {
        return problem(401, "invalid_access_token", "Sign in again.");
    };
    if principal.subject != access.subject {
        return problem(401, "subject_mismatch", "Sign in again.");
    }
    let expires = session_expiry(
        crypto::verified_exp(&tokens.id_token)?,
        crypto::verified_exp(&tokens.access_token)?,
        now,
    );
    if expires <= now {
        return problem(401, "session_expired", "Sign in again.");
    }
    let id = crypto::random()?;
    let csrf = crypto::random()?;
    let claims = crypto::verified_claims(&tokens.id_token)?;
    let name = claims["name"]
        .as_str()
        .or_else(|| claims["preferred_username"].as_str())
        .filter(|v| !v.is_empty() && v.chars().count() <= 160 && !v.chars().any(char::is_control))
        .map(JsValue::from_str)
        .unwrap_or(JsValue::NULL);
    env.d1("SESSIONS")?.prepare("INSERT INTO subscribe_sessions(session_hash,subject,name,access_token,csrf,return_to,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .bind(&[crypto::hash(&id).into(),principal.subject.into(),name,tokens.access_token.into(),csrf.into(),tx.return_to.as_deref().map(JsValue::from_str).unwrap_or(JsValue::NULL),JsValue::from_f64(expires as f64)])?.run().await?;
    // Reauthentication replaces the browser's prior session rather than leaving a live orphan.
    if let Some(old) = store::cookie(req, "__Host-subscribe-session")? {
        env.d1("SESSIONS")?
            .prepare("DELETE FROM subscribe_sessions WHERE session_hash=?1")
            .bind(&[crypto::hash(&old).into()])?
            .run()
            .await?;
    }
    let allowlist: Vec<String> =
        serde_json::from_str(&env.var("RETURN_URL_ALLOWLIST")?.to_string())?;
    let location = portal_location(
        &env.var("APP_ORIGIN")?.to_string(),
        Some(&tx.local_path),
        tx.return_to.as_deref(),
        &allowlist,
    )?;
    let mut response = redirect(location.as_str())?;
    response
        .headers_mut()
        .append("Set-Cookie", &session_cookie(&id, expires - now))?;
    response
        .headers_mut()
        .append("Set-Cookie", &login_cookie("", 0))?;
    Ok(response)
}

/// Return only server-chosen failure categories and previously validated context to the UI.
fn login_failure(
    env: &Env,
    path: Option<&str>,
    return_to: Option<&str>,
    category: &str,
) -> Result<Response> {
    let app = env.var("APP_ORIGIN")?.to_string();
    let allowlist: Vec<String> =
        serde_json::from_str(&env.var("RETURN_URL_ALLOWLIST")?.to_string())?;
    let location = recovery_location(&app, path, return_to, &allowlist, category)?;
    let mut response = redirect(&location)?;
    response
        .headers_mut()
        .append("Set-Cookie", &login_cookie("", 0))?;
    Ok(response)
}

/// Build a same-origin recovery URL without reflecting any OAuth response parameters.
fn recovery_location(
    app: &str,
    path: Option<&str>,
    return_to: Option<&str>,
    allowlist: &[String],
    category: &str,
) -> Result<String> {
    let mut destination = portal_location(app, path, return_to, allowlist)?;
    let category = if category == "login_denied" {
        "login_denied"
    } else {
        "login_failed"
    };
    destination
        .query_pairs_mut()
        .append_pair("auth_error", category);
    Ok(destination.into())
}

/// Preserve trusted application context across successful login and later session expiry.
/// OAuth credential/response fields are never copied into the product URL.
fn portal_location(
    app: &str,
    path: Option<&str>,
    return_to: Option<&str>,
    allowlist: &[String],
) -> Result<url::Url> {
    let path = path.filter(|path| policy::local_path(path)).unwrap_or("/");
    let mut destination = url::Url::parse(&format!("{app}{path}"))?;
    if !matches!(destination.path(), "/" | "/account")
        && !hosted_authorization_path(destination.path())
    {
        destination.set_path("/");
        destination.set_query(None);
    }
    if let Some(value) = return_to.filter(|value| policy::return_allowed(value, allowlist)) {
        destination
            .query_pairs_mut()
            .append_pair("return_to", value);
    }
    Ok(destination)
}

/// A session never outlives either verified credential or the application's 30-minute bound.
fn session_expiry(id: i64, access: i64, now: i64) -> i64 {
    id.min(access).min(now + 1800)
}

/// Forward only application-approved headers and a bounded JSON body to the private Billing binding.
async fn proxy(
    req: &mut Request,
    env: &Env,
    session: Option<&store::Session>,
    path: &str,
) -> Result<Response> {
    let mut init = RequestInit::new();
    init.method = req.method();
    init.redirect = RequestRedirect::Manual;
    init.headers = Headers::new();
    init.headers.set("Accept", "application/json")?;
    let parent = req.headers().get("traceparent")?;
    let parent_span = parent
        .as_deref()
        .filter(|value| valid_traceparent(value))
        .map(|value| value[36..52].to_string());
    let trace = trace_context(parent.as_deref())?;
    init.headers.set("traceparent", &trace)?;
    if let Some(session) = session {
        init.headers
            .set("Authorization", &format!("Bearer {}", session.access_token))?;
    }
    if req.method() != Method::Get {
        if req
            .headers()
            .get("Content-Type")?
            .as_deref()
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return problem(415, "unsupported_media_type", "Use JSON.");
        }
        if path == "/v1/activations" {
            let key = req.headers().get("Idempotency-Key")?.unwrap_or_default();
            if !policy::idempotency_key(&key) {
                return problem(
                    400,
                    "invalid_idempotency_key",
                    "Invalid request identifier.",
                );
            }
            init.headers.set("Idempotency-Key", &key)?;
        }
        // Stream chunks so a dishonest Content-Length cannot trigger unbounded buffering.
        let mut stream = req.stream()?;
        let mut bytes = Vec::new();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > 16384 {
                return problem(413, "body_too_large", "Request is too large.");
            }
            bytes.extend_from_slice(&chunk);
        }
        init.body = Some(js_sys::Uint8Array::from(bytes.as_slice()).into());
        init.headers.set("Content-Type", "application/json")?;
    }
    let started = Date::now().as_millis();
    let result = env
        .service("BILLING")?
        .fetch(format!("https://billing.internal{path}"), Some(init))
        .await;
    let _ = TelemetrySpan {
        operation: telemetry_operation(path),
        phase: "dependency_exit",
        trace: &trace,
        parent_span: parent_span.as_deref(),
        started,
    }
    .emit(
        env,
        result
            .as_ref()
            .map(|response| response.status_code())
            .unwrap_or(503),
    )
    .await;
    let upstream = result?;
    if req.method() == Method::Get && session.is_some() && upstream.status_code() == 200 {
        if let Some(id) = upstream_authorization_id(path) {
            if let Ok(Some(context)) = upstream.headers().get("traceparent") {
                if valid_traceparent(&context) {
                    let _ = store_authorization_context(env, id, &context).await;
                }
            }
        }
    }
    // Do not allow an internal service to plant cookies or redirect the browser.
    let mut response =
        Response::from_body(upstream.body().clone())?.with_status(upstream.status_code());
    let media = upstream
        .headers()
        .get("Content-Type")?
        .unwrap_or_else(|| "application/json".into());
    response.headers_mut().set("Content-Type", &media)?;
    if let Some(correlation) = upstream.headers().get("x-moesegfault-correlation-id")? {
        response
            .headers_mut()
            .set("x-moesegfault-correlation-id", &correlation)?;
    }
    Ok(response)
}

/// Require both exact browser Origin and a constant-time session-bound CSRF comparison.
fn csrf_valid(req: &Request, app: &str, expected: &str) -> Result<bool> {
    let origin = req.headers().get("Origin")?;
    let token = req.headers().get("X-CSRF-Token")?.unwrap_or_default();
    Ok(csrf_matches(origin.as_deref(), app, &token, expected))
}

/// Keep the policy independently testable without constructing a JavaScript Request.
fn csrf_matches(origin: Option<&str>, app: &str, token: &str, expected: &str) -> bool {
    origin == Some(app)
        && !expected.is_empty()
        && bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
}

/// Reject ambiguous repeated security parameters rather than selecting the first or last value.
fn query(url: &url::Url, key: &str) -> Result<Option<String>> {
    let mut values = url
        .query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned());
    let first = values.next();
    if values.next().is_some() {
        return Err(Error::RustError("ambiguous parameter".into()));
    }
    Ok(first)
}

/// Host-only cookies never expose token values or permit parent-domain overrides.
fn login_cookie(id: &str, age: i64) -> String {
    format!("__Host-subscribe-login={id}; Path=/; Max-Age={age}; Secure; HttpOnly; SameSite=Lax")
}

/// Authenticated session cookies retain their independently token-bounded expiry.
fn session_cookie(id: &str, age: i64) -> String {
    format!("__Host-subscribe-session={id}; Path=/; Max-Age={age}; Secure; HttpOnly; SameSite=Lax")
}

/// Construct a fixed-status top-level redirect, never reflecting unvalidated callback parameters.
fn redirect(location: &str) -> Result<Response> {
    let mut response = Response::empty()?.with_status(303);
    response.headers_mut().set("Location", location)?;
    Ok(response)
}

/// Stable RFC 9457 error fields for browser clients; details never include upstream secrets.
fn problem(status: u16, code: &str, title: &str) -> Result<Response> {
    let mut response = Response::from_json(
        &json!({"type":"about:blank","status":status,"title":title,"error_code":code}),
    )?
    .with_status(status);
    response
        .headers_mut()
        .set("Content-Type", "application/problem+json")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_owned_authorization_handoff_preserves_original_trace_ancestry() {
        let original = "00-11111111111111111111111111111111-2222222222222222-01";
        let browser = "00-33333333333333333333333333333333-4444444444444444-01";
        assert_eq!(
            preferred_trace_parent(Some(original.into()), Some(browser.into())).as_deref(),
            Some(original)
        );
        assert_eq!(
            preferred_trace_parent(Some("invalid".into()), Some(browser.into())).as_deref(),
            Some(browser)
        );
        assert!(preferred_trace_parent(Some("invalid".into()), None).is_none());
        let id = "opaque_authorization_identifier_123";
        assert_eq!(
            upstream_authorization_id(&format!("/v1/authorizations/{id}")),
            Some(id)
        );
        assert!(upstream_authorization_id(&format!("/v1/authorizations/{id}/approve")).is_none());
        assert!(
            amail_authorization_path(
                &format!("/api/amail/authorizations/{id}/approve"),
                Method::Post
            )
            .is_some()
        );
        assert_eq!(AUTHORIZATION_TRACE_TTL_MS, 1800000);
    }

    #[test]
    fn trace_queries_reject_unknown_fields_and_invalid_identifiers() {
        assert!(trace_query_valid("0123456789abcdef0123456789abcdef"));
        for id in [
            "00000000000000000000000000000000",
            "0123456789ABCDEF0123456789abcdef",
            "short",
            "private/capability",
        ] {
            assert!(!trace_query_valid(id));
        }
        assert!(
            serde_json::from_str::<TraceQuery>(
                r#"{"trace_id":"0123456789abcdef0123456789abcdef","url":"private"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<TraceQuery>(r#"{"trace_id":"first","trace_id":"second"}"#)
                .is_err()
        );
        assert_eq!(TRACE_RETENTION_MS, 604800000);
    }

    #[test]
    fn telemetry_envelope_is_closed_uuid_identified_and_uses_utc_start_time() {
        let event = telemetry_event_id([255; 16]);
        assert_eq!(event, "ffffffff-ffff-4fff-bfff-ffffffffffff");
        let span = TelemetrySpan {
            operation: "amail.authorization.approve",
            phase: "request_exit",
            trace: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
            parent_span: Some("1111111111111111"),
            started: 1800000000000,
        };
        let record = span.record(&event, 1800000000012, 200);
        let expected = [
            "schema_version",
            "event_id",
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
        assert_eq!(record.as_object().unwrap().len(), expected.len());
        assert!(expected.iter().all(|key| record.get(key).is_some()));
        assert_eq!(record["service"], "subscribe");
        assert_eq!(record["occurred_at_ms"], 1800000000000u64);
        assert_eq!(record["duration_ms"], 12);
        assert_eq!(record["http_status"], 200);
        assert_eq!(record["outcome"], "success");
        assert_eq!(span.record(&event, 0, 403)["outcome"], "client_error");
        assert_eq!(span.record(&event, 0, 503)["outcome"], "server_error");
        assert_eq!(span.record(&event, 0, 503)["duration_ms"], 0);
        let root = TelemetrySpan {
            parent_span: None,
            phase: "dependency_exit",
            ..span
        };
        assert!(root.record(&event, 1800000000001, 200)["parent_span_id"].is_null());
    }

    #[test]
    fn traces_are_bounded_and_operations_redact_private_identifiers() {
        assert!(valid_traceparent(
            "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        ));
        assert!(!valid_traceparent(
            "00-00000000000000000000000000000000-0123456789abcdef-01"
        ));
        assert!(!valid_traceparent(
            "00-0123456789ABCDEF0123456789abcdef-0123456789abcdef-01"
        ));
        assert_eq!(
            telemetry_operation("/api/amail/authorizations/private_opaque_identifier/approve"),
            "amail.authorization.approve"
        );
    }

    #[test]
    fn authorization_proxy_only_accepts_fixed_operations() {
        let id = "opaque_authorization_identifier_123";
        assert_eq!(
            amail_authorization_path(&format!("/api/amail/authorizations/{id}"), Method::Get),
            Some(format!("/v1/authorizations/{id}"))
        );
        assert!(
            amail_authorization_path(
                &format!("/api/amail/authorizations/{id}/approve"),
                Method::Post
            )
            .is_some()
        );
        assert!(
            amail_authorization_path(
                &format!("/api/amail/authorizations/{id}/cancel"),
                Method::Post
            )
            .is_some()
        );
        for suffix in [
            "../me",
            "short",
            "opaque_authorization_identifier_123/approve/extra",
            "opaque_authorization_identifier_123?secret",
        ] {
            assert!(
                amail_authorization_path(
                    &format!("/api/amail/authorizations/{suffix}"),
                    Method::Get
                )
                .is_none()
            );
        }
        assert!(
            amail_authorization_path(
                &format!("/api/amail/authorizations/{id}/approve"),
                Method::Get
            )
            .is_none()
        );
    }

    #[test]
    fn login_preserves_hosted_authorization_context() {
        let destination = portal_location(
            "https://subscribe.example",
            Some("/amail/authorize/opaque_authorization_identifier_123"),
            None,
            &[],
        )
        .unwrap();
        assert_eq!(
            destination.path(),
            "/amail/authorize/opaque_authorization_identifier_123"
        );
        assert_eq!(destination.query(), None);
    }

    #[test]
    fn expires_with_earliest_credential() {
        assert_eq!(session_expiry(200, 300, 100), 200);
        assert_eq!(session_expiry(300, 200, 100), 200);
        assert_eq!(session_expiry(9000, 9000, 100), 1900);
    }
    #[test]
    fn preauth_deadline_covers_registration_without_extending_authenticated_tokens() {
        assert_eq!(PREAUTH_TTL_SECONDS, 1800);
        assert!(PREAUTH_TTL_SECONDS >= 5 * 60 + 10 * 60 + 10 * 60);
        assert!(login_cookie("browser-bound-id", PREAUTH_TTL_SECONDS).contains("Max-Age=1800"));
        assert!(login_cookie("", 0).contains("Max-Age=0"));
        assert_eq!(session_expiry(400, 400, 100), 400);
    }
    #[test]
    fn rejects_duplicate_callback_parameters() {
        let url = url::Url::parse("https://subscribe.test/auth/callback?state=a&state=b").unwrap();
        assert!(query(&url, "state").is_err());
    }
    #[test]
    fn csrf_requires_exact_origin_and_session_secret() {
        let app = "https://subscribe.example";
        assert!(csrf_matches(Some(app), app, "session-a", "session-a"));
        assert!(!csrf_matches(
            Some("https://subscribe.example.evil"),
            app,
            "session-a",
            "session-a"
        ));
        assert!(!csrf_matches(None, app, "session-a", "session-a"));
        assert!(!csrf_matches(Some(app), app, "session-b", "session-a"));
        assert!(!csrf_matches(Some(app), app, "", ""));
    }

    #[test]
    fn recovery_keeps_only_same_origin_path_and_registered_continuation() {
        let app = "https://subscribe.example";
        let allowed: Vec<String> = vec!["https://account.example/subscriptions".into()];
        let recovered = recovery_location(
            app,
            Some("/account?locale=ja&plan=basic"),
            Some(&allowed[0]),
            &allowed,
            "login_denied",
        )
        .unwrap();
        let url = url::Url::parse(&recovered).unwrap();
        assert_eq!(url.origin().ascii_serialization(), app);
        assert_eq!(url.path(), "/account");
        assert_eq!(query(&url, "locale").unwrap().as_deref(), Some("ja"));
        assert_eq!(query(&url, "plan").unwrap().as_deref(), Some("basic"));
        assert_eq!(
            query(&url, "auth_error").unwrap().as_deref(),
            Some("login_denied")
        );
        assert_eq!(
            query(&url, "return_to").unwrap().as_deref(),
            Some(allowed[0].as_str())
        );
        let unsafe_url = recovery_location(
            app,
            Some("//evil.test"),
            Some("https://evil.test"),
            &allowed,
            "untrusted-error",
        )
        .unwrap();
        assert_eq!(
            unsafe_url,
            "https://subscribe.example/?auth_error=login_failed"
        );
    }

    #[test]
    fn successful_portal_keeps_safe_continuation_without_oauth_fields() {
        let allowed: Vec<String> = vec!["https://account.example/subscriptions".into()];
        let location = portal_location(
            "https://subscribe.example",
            Some("/?app=demo&plan=basic&locale=zh-CN"),
            Some(&allowed[0]),
            &allowed,
        )
        .unwrap();
        assert_eq!(
            query(&location, "return_to").unwrap().as_deref(),
            Some(allowed[0].as_str())
        );
        assert_eq!(query(&location, "app").unwrap().as_deref(), Some("demo"));
        for key in [
            "auth_error",
            "code",
            "state",
            "nonce",
            "id_token",
            "access_token",
        ] {
            assert_eq!(query(&location, key).unwrap(), None);
        }
        let unregistered = portal_location(
            "https://subscribe.example",
            Some("/account"),
            Some("https://evil.example"),
            &allowed,
        )
        .unwrap();
        assert_eq!(query(&unregistered, "return_to").unwrap(), None);
    }
}
