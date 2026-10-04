//! D1 persistence with atomic transaction consumption and opaque session hashes.
use crate::crypto::hash;
use serde::Deserialize;
use wasm_bindgen::JsValue;
use worker::{Env, Request, Result};

/// One expiring browser-bound authorization attempt.
#[derive(Deserialize)]
pub struct Login {
    /// Stored nonce must match the verified ID token.
    pub nonce: String,
    /// Original PKCE material is never exposed to the browser.
    pub verifier: String,
    /// Optional allowlisted application continuation, not an OAuth redirect.
    pub return_to: Option<String>,
    /// Local UI destination selected before login.
    pub local_path: String,
}

/// A server-side token holder, never serialized wholesale to the browser.
#[derive(Deserialize)]
pub struct Session {
    /// Opaque persistent primary key, used for deletion only.
    pub session_hash: String,
    /// Immutable issuer subject; issuer is deployment-pinned.
    pub subject: String,
    /// Optional standard profile display name from the already-verified ID token.
    pub name: Option<String>,
    /// Short-lived access token forwarded only to Billing.
    pub access_token: String,
    /// Browser-readable anti-CSRF secret tied to this session.
    pub csrf: String,
    /// Previously validated external continuation.
    pub return_to: Option<String>,
}

/// Extract only a single named cookie; ambiguous duplicate names fail closed.
pub fn cookie(req: &Request, name: &str) -> Result<Option<String>> {
    let header = req.headers().get("Cookie")?.unwrap_or_default();
    let mut values = header
        .split(';')
        .filter_map(|v| v.trim().split_once('='))
        .filter(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned());
    let first = values.next();
    Ok(if values.next().is_none() { first } else { None })
}

/// Load a currently valid session. Expiration is enforced on every request.
pub async fn session(req: &Request, env: &Env, now: i64) -> Result<Option<Session>> {
    let Some(id) = cookie(req, "__Host-subscribe-session")? else {
        return Ok(None);
    };
    env.d1("SESSIONS")?.prepare("SELECT session_hash,subject,name,access_token,csrf,return_to FROM subscribe_sessions WHERE session_hash=?1 AND expires_at>?2")
        .bind(&[hash(&id).into(), JsValue::from_f64(now as f64)])?.first(None).await
}

/// Consume an authorization attempt once, atomically and only for its bound browser.
pub async fn consume(env: &Env, state: &str, browser: &str, now: i64) -> Result<Option<Login>> {
    env.d1("SESSIONS")?.prepare("DELETE FROM subscribe_login WHERE state_hash=?1 AND browser_hash=?2 AND expires_at>?3 RETURNING nonce,verifier,return_to,local_path")
        .bind(&[hash(state).into(),hash(browser).into(), JsValue::from_f64(now as f64)])?.first(None).await
}
