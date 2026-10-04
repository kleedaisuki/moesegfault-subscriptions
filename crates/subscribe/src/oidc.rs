//! Fixed-issuer OIDC discovery and confidential authorization-code exchange.
use crate::crypto;
use serde::Deserialize;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Result};

/// Discovered endpoints, checked against the deployment-owned issuer origin.
#[derive(Deserialize)]
pub struct Discovery {
    /// Exact issuer identifier, not inferred from token claims.
    pub issuer: String,
    /// Provider authorization endpoint.
    pub authorization_endpoint: String,
    /// Provider confidential token endpoint.
    pub token_endpoint: String,
}

/// A token response whose values remain exclusively in server memory and D1.
#[derive(Deserialize)]
pub struct Tokens {
    /// Identity proof checked with nonce before session creation.
    pub id_token: String,
    /// Access credential verified independently and forwarded only to Billing.
    pub access_token: String,
    /// Must be Bearer; unsupported schemes fail closed.
    pub token_type: String,
}

/// Reject endpoint drift and redirects so discovery cannot move credentials elsewhere.
pub async fn discover(env: &Env) -> Result<Discovery> {
    let issuer = env.var("ISSUER")?.to_string();
    let mut init = RequestInit::new();
    init.redirect = worker::RequestRedirect::Manual;
    let req = Request::new_with_init(
        &format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
        &init,
    )?;
    let mut response = Fetch::Request(req).send().await?;
    if response.status_code() != 200 {
        return Err(worker::Error::RustError("discovery unavailable".into()));
    }
    let discovery: Discovery = response.json().await?;
    let fixed = url::Url::parse(&issuer)?;
    if discovery.issuer != issuer || fixed.scheme() != "https" {
        return Err(worker::Error::RustError("issuer mismatch".into()));
    }
    for endpoint in [&discovery.authorization_endpoint, &discovery.token_endpoint] {
        let parsed = url::Url::parse(endpoint)?;
        if parsed.origin() != fixed.origin()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err(worker::Error::RustError("endpoint mismatch".into()));
        }
    }
    Ok(discovery)
}

/// Exchange a single consumed code, with PKCE and a fresh private-key JWT assertion.
pub async fn exchange(
    env: &Env,
    endpoint: &str,
    code: &str,
    verifier: &str,
    now: i64,
) -> Result<Tokens> {
    let assertion = crypto::assertion(env, endpoint, now).await?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            (
                "redirect_uri",
                &format!("{}/auth/callback", env.var("APP_ORIGIN")?),
            ),
            ("client_id", &env.var("CLIENT_ID")?.to_string()),
            (
                "client_assertion_type",
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            ),
            ("client_assertion", &assertion),
        ])
        .finish();
    let mut init = RequestInit::new();
    init.method = Method::Post;
    init.redirect = worker::RequestRedirect::Manual;
    init.headers = Headers::new();
    init.headers
        .set("Content-Type", "application/x-www-form-urlencoded")?;
    init.body = Some(form.into());
    let mut response = Fetch::Request(Request::new_with_init(endpoint, &init)?)
        .send()
        .await?;
    if response.status_code() != 200 {
        return Err(worker::Error::RustError("code exchange rejected".into()));
    }
    let tokens: Tokens = response.json().await?;
    if !tokens.token_type.eq_ignore_ascii_case("Bearer") {
        return Err(worker::Error::RustError("unsupported token type".into()));
    }
    Ok(tokens)
}
