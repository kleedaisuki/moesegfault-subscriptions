//! Billing resource server: Identity authenticates humans; this service owns billing state.
#![forbid(unsafe_code)]

mod admin;
mod amail;
mod amail_usage;
pub mod auth;
pub mod domain;
mod repository;
mod telemetry;

use serde::Deserialize;
use serde_json::json;
use worker::*;

/// Cloudflare fetch boundary; errors never expose credentials, SQL, or personal data.
#[cfg(feature = "worker-entry")]
#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _context: Context) -> Result<Response> {
    serve(request, env).await
}

/// Dispatches API operations and applies non-cacheable, nosniff response policy.
pub async fn serve(request: Request, env: Env) -> Result<Response> {
    let mut request = request.clone_mut()?;
    request.headers_mut()?.delete("x-billing-authenticated")?;
    let started_at_ms = worker::Date::now().as_millis();
    let response = route(&mut request, &env).await.unwrap_or_else(|_| {
        problem(500, "internal_error", "Billing is temporarily unavailable").unwrap()
    });
    let mut response = response;
    let correlation = domain::random_token()?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    response
        .headers_mut()
        .set("x-moesegfault-correlation-id", &correlation)?;
    let _ = telemetry::finish(&request, &mut response, started_at_ms, &env).await;
    Ok(response)
}

/// Resolves public, administrator, and user surfaces without mixing their credentials.
async fn route(request: &mut Request, env: &Env) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    let method = request.method();
    if path.starts_with("/v1/service/amail/") {
        return amail::service_route(request, env, &path).await;
    }
    if method == Method::Get && path == "/healthz" {
        return Response::from_json(&json!({"status":"ok"}));
    }
    if method == Method::Get && path == "/v1/plans" {
        return Response::from_json(&json!({"plans":domain::registry(env)?}));
    }
    if method == Method::Post && path == "/v1/admin/activation-codes" {
        return admin::issue(request, env).await;
    }
    if !path.starts_with("/v1/authorizations/")
        && !matches!(
            (method.clone(), path.as_str()),
            (Method::Get, "/v1/me")
                | (Method::Put, "/v1/me/profile")
                | (Method::Post, "/v1/activations")
        )
    {
        return problem(404, "not_found", "Not found");
    }
    let principal = match auth::verify(request, env).await {
        Ok(principal) => principal,
        Err(auth::AuthError::Unauthorized) => {
            let mut response = problem(401, "invalid_token", "Sign in to continue")?;
            response
                .headers_mut()
                .set("WWW-Authenticate", "Bearer error=\"invalid_token\"")?;
            return Ok(response);
        }
        Err(auth::AuthError::Forbidden) => {
            return problem(
                403,
                "insufficient_scope",
                "Your account cannot access this operation",
            );
        }
        Err(auth::AuthError::Unavailable) => {
            return problem(
                503,
                "identity_unavailable",
                "Sign-in verification is temporarily unavailable",
            );
        }
        Err(auth::AuthError::Configuration) => {
            return problem(
                500,
                "identity_configuration_error",
                "Billing is temporarily unavailable",
            );
        }
    };
    request.headers_mut()?.set("x-billing-authenticated", "1")?;
    if path.starts_with("/v1/authorizations/") {
        return amail::browser_route(request, env, &path, &principal.issuer, &principal.subject)
            .await;
    }
    let db = env.d1("BILLING_DB")?;
    let account = repository::ensure_account(&db, &principal.issuer, &principal.subject).await?;
    if method == Method::Get {
        return Response::from_json(&json!({"account": account,
            "subscriptions":repository::subscriptions(&db, &account.id).await?}));
    }
    if method == Method::Put {
        let profile: domain::BillingProfile = match read_json(request).await {
            Ok(v) => v,
            Err(_) => return problem(400, "invalid_profile", "Check your billing information"),
        };
        let profile = match profile.normalize() {
            Ok(profile) => profile,
            Err(code) => return problem(400, code, "Check your billing information"),
        };
        return Response::from_json(
            &json!({"account":repository::save_profile(&db, &account.id, &profile).await?}),
        );
    }
    let payload: Activation = match read_json(request).await {
        Ok(v) => v,
        Err(_) => {
            return problem(
                400,
                "invalid_activation_code",
                "Enter a valid activation code",
            );
        }
    };
    let code = payload.code.trim();
    if code.len() < 24
        || code.len() > 128
        || !code
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return problem(
            400,
            "invalid_activation_code",
            "Enter a valid activation code",
        );
    }
    let key = request
        .headers()
        .get("Idempotency-Key")?
        .unwrap_or_default();
    if key.len() < 16 || key.len() > 128 || !key.bytes().all(|c| c.is_ascii_graphic()) {
        return problem(
            400,
            "idempotency_key_required",
            "Retry the activation request",
        );
    }
    repository::activate(&db, &account.id, code, &key).await
}

/// Bounded JSON parsing protects CPU and memory; all mutable APIs require application/json.
pub(crate) async fn read_json<T: serde::de::DeserializeOwned>(request: &mut Request) -> Result<T> {
    let content_type = request.headers().get("Content-Type")?.unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .is_some_and(|v| v.trim() == "application/json")
    {
        return Err(Error::RustError("json_required".into()));
    }
    let body = request.text().await?;
    if body.len() > 8192 {
        return Err(Error::RustError("body_too_large".into()));
    }
    serde_json::from_str(&body).map_err(|_| Error::RustError("invalid_json".into()))
}

/// Stable machine errors deliberately exclude implementation details and personal data.
pub(crate) fn problem(status: u16, code: &str, title: &str) -> Result<Response> {
    let mut response = Response::from_json(
        &json!({"type":format!("https://billing.moesegfault.dev/problems/{code}"),
        "title":title,"status":status,"error_code":code}),
    )?
    .with_status(status);
    response
        .headers_mut()
        .set("Content-Type", "application/problem+json")?;

    Ok(response)
}

/// Activation input contains only a credential, never a caller-selected plan or identity.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activation {
    code: String,
}
