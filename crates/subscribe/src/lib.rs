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

/// Cloudflare entrypoint. Internal failures deliberately reveal no credentials or provider body.
#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let correlation = crypto::random()?;
    let path = req.path();
    let dynamic = path.starts_with("/api/") || path.starts_with("/auth/") || path == "/healthz";
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

/// Create browser-bound PKCE state; external continuation is data for the UI, never callback redirect.
async fn login(req: &Request, env: &Env, now: i64) -> Result<Response> {
    let url = req.url()?;
    let path = query(&url, "path")?.unwrap_or_else(|| "/".into());
    if !matches!(path.as_str(), "/" | "/account") {
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
            .bind(&[crypto::hash(&state).into(),crypto::hash(&browser).into(),nonce.clone().into(),verifier.clone().into(),return_to.map(JsValue::from).unwrap_or(JsValue::NULL),local_path.into(),JsValue::from_f64((now+600) as f64)])?,
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
    response.headers_mut().append(
        "Set-Cookie",
        &format!(
            "__Host-subscribe-login={browser}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax"
        ),
    )?;
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
    response.headers_mut().append(
        "Set-Cookie",
        "__Host-subscribe-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    )?;
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
    response.headers_mut().append(
        "Set-Cookie",
        "__Host-subscribe-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    )?;
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
    if !matches!(destination.path(), "/" | "/account") {
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
    let upstream = env
        .service("BILLING")?
        .fetch(format!("https://billing.internal{path}"), Some(init))
        .await?;
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
    fn expires_with_earliest_credential() {
        assert_eq!(session_expiry(200, 300, 100), 200);
        assert_eq!(session_expiry(300, 200, 100), 200);
        assert_eq!(session_expiry(9000, 9000, 100), 1900);
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
