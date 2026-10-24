//! Fixed-issuer OIDC discovery and confidential authorization-code exchange.
use crate::crypto;
use serde::Deserialize;
use std::cell::RefCell;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Result};

/// Discovered endpoints, checked against the deployment-owned issuer origin.
#[derive(Clone, Deserialize)]
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

const DISCOVERY_TTL_SECONDS: i64 = 300;
const MAX_DISCOVERY_BYTES: usize = 64 * 1024;

struct CachedDiscovery {
    value: Discovery,
    expires: i64,
}

thread_local! {
    // One fixed deployment issuer; replacing the entry bounds memory across environments.
    static DISCOVERY: RefCell<Option<CachedDiscovery>> = const { RefCell::new(None) };
}

fn cached_discovery(issuer: &str, now: i64) -> Option<Discovery> {
    DISCOVERY.with(|cache| {
        cache
            .borrow()
            .as_ref()
            .filter(|entry| entry.value.issuer == issuer && entry.expires > now)
            .map(|entry| entry.value.clone())
    })
}

/// Reject endpoint drift and redirects so discovery cannot move credentials elsewhere.
pub async fn discover(env: &Env) -> Result<Discovery> {
    let issuer = env.var("ISSUER")?.to_string();
    let now = worker::Date::now().as_millis() as i64 / 1000;
    if let Some(discovery) = cached_discovery(&issuer, now) {
        return Ok(discovery);
    }
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
    use futures_util::StreamExt;
    let mut stream = response.stream()?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > MAX_DISCOVERY_BYTES {
            return Err(worker::Error::RustError("discovery too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    let discovery: Discovery = serde_json::from_slice(&body)?;
    validate_discovery(&issuer, &discovery)?;
    DISCOVERY.with(|cache| {
        *cache.borrow_mut() = Some(CachedDiscovery {
            value: discovery.clone(),
            expires: now + DISCOVERY_TTL_SECONDS,
        })
    });
    Ok(discovery)
}

fn validate_discovery(issuer: &str, discovery: &Discovery) -> Result<()> {
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(issuer: &str) -> Discovery {
        Discovery {
            issuer: issuer.into(),
            authorization_endpoint: format!("{issuer}/authorize"),
            token_endpoint: format!("{issuer}/token"),
        }
    }

    #[test]
    fn discovery_cache_is_issuer_pinned_and_expires_at_exact_deadline() {
        let issuer = "https://identity.example";
        DISCOVERY.with(|cache| {
            *cache.borrow_mut() = Some(CachedDiscovery {
                value: metadata(issuer),
                expires: 400,
            })
        });
        assert!(cached_discovery(issuer, 399).is_some());
        assert!(cached_discovery(issuer, 400).is_none());
        assert!(cached_discovery("https://another.example", 399).is_none());
        DISCOVERY.with(|cache| *cache.borrow_mut() = None);
    }

    #[test]
    fn cached_endpoints_are_validated_before_acceptance() {
        let issuer = "https://identity.example";
        assert!(validate_discovery(issuer, &metadata(issuer)).is_ok());
        assert!(validate_discovery(issuer, &metadata("https://other.example")).is_err());
        assert!(
            validate_discovery(
                "http://identity.example",
                &metadata("http://identity.example")
            )
            .is_err()
        );
        for endpoint in [
            "https://other.example/token",
            "https://user@identity.example/token",
            "https://identity.example/token#fragment",
        ] {
            let mut discovery = metadata(issuer);
            discovery.token_endpoint = endpoint.into();
            assert!(validate_discovery(issuer, &discovery).is_err());
        }
    }
}
