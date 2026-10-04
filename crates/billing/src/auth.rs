//! Issuer-pinned Identity JWT verification; cryptography belongs to Workers WebCrypto.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use js_sys::{Array, JSON, Object, Reflect};
use serde::Deserialize;
use serde_json::Value;
use std::{cell::RefCell, collections::BTreeMap, fmt};
use url::Url;
use wasm_bindgen::JsCast as _;
use wasm_bindgen_futures::JsFuture;
use worker::{Env, Fetch, Request, RequestInit, RequestRedirect};

const SKEW: i64 = 30;
const CACHE_TTL: i64 = 300;
const REFRESH_INTERVAL: i64 = 30;
const MAX_KEYS: usize = 32;

/// Stable application identity, never inferred from mutable profile attributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    /// Exact validated issuer.
    pub issuer: String,
    /// Pairwise subject in the registered client sector.
    pub subject: String,
    /// Accepted registered client ID, not an invented resource audience.
    pub audience: String,
}

/// Explicit acceptance policy shared by Billing and the Subscribe BFF.
///
/// For callback ID tokens use `token_use = "id"`, the stored nonce, and no scope.
/// For resource access use `token_use = "access"` and `required_scope = Some("openid")`.
#[derive(Debug, Clone)]
pub struct ValidationPolicy {
    /// Deployment-pinned HTTPS issuer; never obtain this value from a token.
    pub issuer: String,
    /// Exact client IDs approved for this service and deployment environment.
    pub audiences: Vec<String>,
    /// Current provider discriminator: either `access` or `id`.
    pub token_use: String,
    /// Required ID-token nonce recovered from the one-time login transaction.
    pub nonce: Option<String>,
    /// Required space-delimited access scope, if applicable.
    pub required_scope: Option<String>,
}

/// Public failure categories contain no credentials or personal identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// Missing, malformed, expired, or otherwise unacceptable credentials.
    Unauthorized,
    /// Required scope was not granted.
    Forbidden,
    /// Invalid deployment trust configuration.
    Configuration,
    /// Discovery, keys, or platform cryptography are temporarily unavailable.
    Unavailable,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unauthorized => "invalid_identity_credentials",
            Self::Forbidden => "insufficient_identity_scope",
            Self::Configuration => "identity_configuration_error",
            Self::Unavailable => "identity_verification_unavailable",
        })
    }
}
impl std::error::Error for AuthError {}

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
    #[serde(default)]
    crit: Option<Value>,
    #[serde(default)]
    b64: Option<Value>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: i64,
    iat: i64,
    token_use: String,
    #[serde(default)]
    nbf: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
}

type Refresh = Shared<LocalBoxFuture<'static, Result<Vec<Value>, AuthError>>>;

#[derive(Default)]
struct KeyCache {
    keys: Vec<(Value, i64)>,
    expires: i64,
    next_refresh: i64,
    refreshing: Option<Refresh>,
}

thread_local! {
    // One deployment normally has one issuer. Bound memory even if called with bad policies.
    static KEYS: RefCell<BTreeMap<String, KeyCache>> = RefCell::new(BTreeMap::new());
}

/// Validate a Billing bearer request using environment-owned issuer and audience policy.
pub async fn verify(req: &Request, env: &Env) -> Result<Principal, AuthError> {
    let authorization = req
        .headers()
        .get("Authorization")
        .map_err(|_| AuthError::Unauthorized)?
        .ok_or(AuthError::Unauthorized)?;
    let (scheme, token) = authorization
        .split_once(' ')
        .ok_or(AuthError::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("Bearer")
        || token.is_empty()
        || token.contains(char::is_whitespace)
    {
        return Err(AuthError::Unauthorized);
    }
    let audiences = serde_json::from_str(
        &env.var("BILLING_AUDIENCES")
            .map_err(|_| AuthError::Configuration)?
            .to_string(),
    )
    .map_err(|_| AuthError::Configuration)?;
    let policy = ValidationPolicy {
        issuer: env
            .var("IDENTITY_ISSUER")
            .map_err(|_| AuthError::Configuration)?
            .to_string(),
        audiences,
        token_use: "access".into(),
        nonce: None,
        required_scope: Some("openid".into()),
    };
    verify_token(token, env, &policy).await
}

/// Verify a compact token under a caller-supplied trusted policy.
///
/// `env` supplies diagnostic environment only, never fallback keys or alternate issuers. Unknown keys trigger
/// one coalesced refresh per isolate every 30 seconds; token-supplied key URLs are ignored.
pub async fn verify_token(
    token: &str,
    env: &Env,
    policy: &ValidationPolicy,
) -> Result<Principal, AuthError> {
    validate_policy(policy).map_err(|error| rejection(env, "policy", error))?;
    if token.len() > 16_384 {
        return Err(rejection(env, "token_size", AuthError::Unauthorized));
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(rejection(env, "compact", AuthError::Unauthorized));
    }
    let header: Header =
        decode_json(parts[0]).map_err(|error| rejection(env, "header_json", error))?;
    if header.alg != "RS256"
        || header.typ != "JWT"
        || header.kid.is_empty()
        || header.kid.len() > 128
        || header.crit.is_some()
        || header.b64.is_some()
    {
        return Err(rejection(env, "header_policy", AuthError::Unauthorized));
    }
    let claims: Claims =
        decode_json(parts[1]).map_err(|error| rejection(env, "claims_json", error))?;
    let timestamp = now();
    let claim_stage = claim_rejection_stage(&claims, policy, timestamp);
    let principal = validate_claims(claims, policy, timestamp)
        .map_err(|error| rejection(env, claim_stage, error))?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| rejection(env, "signature_encoding", AuthError::Unauthorized))?;
    if signature.len() < 256 || signature.len() > 1024 {
        return Err(rejection(env, "signature_size", AuthError::Unauthorized));
    }
    let key = signing_key(&policy.issuer, &header.kid)
        .await
        .map_err(|error| rejection(env, "jwks", error))?;
    let input = format!("{}.{}", parts[0], parts[1]);
    if !verify_signature(&key, &signature, input.as_bytes())
        .await
        .map_err(|error| rejection(env, "webcrypto", error))?
    {
        return Err(rejection(
            env,
            "signature_mismatch",
            AuthError::Unauthorized,
        ));
    }
    Ok(principal)
}

/// Stage-only diagnostics are categorical constants, never untrusted token material.
fn rejection(env: &Env, stage: &'static str, error: AuthError) -> AuthError {
    if env
        .var("ENVIRONMENT")
        .is_ok_and(|value| value.to_string() == "staging")
    {
        worker::console_warn!(
            "identity_verification_rejected stage={} category={}",
            stage,
            error
        );
    }
    error
}

/// Classifies claim failures without serializing, logging, or returning a claim value.
fn claim_rejection_stage(c: &Claims, p: &ValidationPolicy, timestamp: i64) -> &'static str {
    if c.iss != p.issuer {
        return "issuer";
    }
    if c.token_use != p.token_use {
        return "token_kind";
    }
    if c.sub.is_empty() || c.sub.len() > 256 || c.sub.chars().any(char::is_control) {
        return "subject_format";
    }
    if c.iat < 0
        || c.exp <= c.iat
        || c.exp <= timestamp - SKEW
        || c.iat > timestamp + SKEW
        || c.nbf
            .is_some_and(|nbf| nbf > timestamp + SKEW || nbf > c.exp)
    {
        return "token_time";
    }
    if p.nonce
        .as_ref()
        .is_some_and(|nonce| c.nonce.as_ref() != Some(nonce))
    {
        return "nonce";
    }
    let audiences: Vec<&str> = match &c.aud {
        Audience::One(a) => vec![a.as_str()],
        Audience::Many(a) => a.iter().map(String::as_str).collect(),
    };
    let Some(audience) = audiences
        .iter()
        .find(|a| p.audiences.iter().any(|expected| expected == **a))
    else {
        return "audience";
    };
    if (p.token_use == "access" && audiences.len() != 1)
        || (audiences.len() > 1 && c.azp.as_deref() != Some(*audience))
        || c.azp.as_deref().is_some_and(|azp| azp != *audience)
        || (p.token_use == "access" && c.client_id.as_deref().is_some_and(|id| id != *audience))
    {
        return "authorized_party";
    }
    if p.required_scope.as_ref().is_some_and(|scope| {
        !c.scope
            .as_deref()
            .unwrap_or("")
            .split_ascii_whitespace()
            .any(|value| value == scope)
    }) {
        return "scope";
    }
    "claims_policy"
}

fn decode_json<T: serde::de::DeserializeOwned>(part: &str) -> Result<T, AuthError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| AuthError::Unauthorized)?;
    serde_json::from_slice(&bytes).map_err(|_| AuthError::Unauthorized)
}

fn validate_policy(policy: &ValidationPolicy) -> Result<(), AuthError> {
    let issuer = Url::parse(&policy.issuer).map_err(|_| AuthError::Configuration)?;
    if issuer.scheme() != "https"
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || policy.audiences.is_empty()
        || policy.audiences.len() > 8
        || policy.audiences.iter().any(|aud| aud.is_empty())
        || !matches!(policy.token_use.as_str(), "access" | "id")
        || (policy.token_use == "id" && policy.nonce.as_ref().is_none_or(String::is_empty))
    {
        return Err(AuthError::Configuration);
    }
    Ok(())
}

fn validate_claims(c: Claims, p: &ValidationPolicy, now: i64) -> Result<Principal, AuthError> {
    if c.iss != p.issuer
        || c.token_use != p.token_use
        || c.sub.is_empty()
        || c.sub.len() > 256
        || c.sub.chars().any(char::is_control)
        || c.iat < 0
        || c.exp <= c.iat
        || c.exp <= now - SKEW
        || c.iat > now + SKEW
        || c.nbf.is_some_and(|nbf| nbf > now + SKEW || nbf > c.exp)
        || p.nonce
            .as_ref()
            .is_some_and(|nonce| c.nonce.as_ref() != Some(nonce))
    {
        return Err(AuthError::Unauthorized);
    }
    let audiences = match c.aud {
        Audience::One(a) => vec![a],
        Audience::Many(a) => a,
    };
    let audience = audiences
        .iter()
        .find(|a| p.audiences.contains(a))
        .ok_or(AuthError::Unauthorized)?
        .clone();
    if (p.token_use == "access" && audiences.len() != 1)
        || (audiences.len() > 1 && c.azp.as_deref() != Some(audience.as_str()))
        || c.azp.as_ref().is_some_and(|azp| azp != &audience)
        || (p.token_use == "access" && c.client_id.as_ref().is_some_and(|id| id != &audience))
    {
        return Err(AuthError::Unauthorized);
    }
    if p.required_scope.as_ref().is_some_and(|scope| {
        !c.scope
            .as_deref()
            .unwrap_or("")
            .split_ascii_whitespace()
            .any(|s| s == scope)
    }) {
        return Err(AuthError::Forbidden);
    }
    Ok(Principal {
        issuer: c.iss,
        subject: c.sub,
        audience,
    })
}

fn now() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

fn cached_key(cache: &KeyCache, kid: &str, now: i64) -> Option<Value> {
    cache
        .keys
        .iter()
        .find(|(key, expires)| *expires > now && key["kid"].as_str() == Some(kid))
        .map(|(key, _)| key.clone())
}

async fn signing_key(issuer: &str, kid: &str) -> Result<Value, AuthError> {
    let timestamp = now();
    let refresh = KEYS.with(|cell| {
        let mut caches = cell.borrow_mut();
        if !caches.contains_key(issuer) && caches.len() >= 4 {
            return Err(AuthError::Configuration);
        }
        let cache = caches.entry(issuer.to_owned()).or_default();
        if cache.expires > timestamp {
            if let Some(key) = cached_key(cache, kid, timestamp) {
                return Ok(Ok(key));
            }
        }
        if let Some(refresh) = &cache.refreshing {
            return Ok(Err(refresh.clone()));
        }
        if cache.next_refresh > timestamp {
            return Err(if cache.expires > timestamp {
                AuthError::Unauthorized
            } else {
                AuthError::Unavailable
            });
        }
        cache.next_refresh = timestamp + REFRESH_INTERVAL;
        let fixed_issuer = issuer.to_owned();
        let refresh = async move { fetch_keys(&fixed_issuer).await }
            .boxed_local()
            .shared();
        cache.refreshing = Some(refresh.clone());
        Ok(Err(refresh))
    })?;
    let refresh = match refresh {
        Ok(key) => return Ok(key),
        Err(refresh) => refresh,
    };
    let result = refresh.await;
    KEYS.with(|cell| {
        let mut caches = cell.borrow_mut();
        let cache = caches.get_mut(issuer).ok_or(AuthError::Unavailable)?;
        cache.refreshing = None;
        let keys = result?;
        // Keep previous signing keys for the provider's 300-second token lifetime plus skew.
        cache.keys.retain(|(_, expires)| *expires > timestamp);
        for key in keys {
            cache.keys.retain(|(old, _)| old["kid"] != key["kid"]);
            cache.keys.push((key, timestamp + CACHE_TTL + 300 + SKEW));
        }
        if cache.keys.len() > MAX_KEYS {
            cache.keys.drain(..cache.keys.len() - MAX_KEYS);
        }
        cache.expires = timestamp + CACHE_TTL;
        cached_key(cache, kid, now()).ok_or(AuthError::Unauthorized)
    })
}

async fn fetch_keys(issuer: &str) -> Result<Vec<Value>, AuthError> {
    let discovery = fetch_json(&format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    ))
    .await?;
    if discovery["issuer"].as_str() != Some(issuer) {
        return Err(AuthError::Unavailable);
    }
    let pinned = Url::parse(issuer).map_err(|_| AuthError::Configuration)?;
    let jwks = Url::parse(
        discovery["jwks_uri"]
            .as_str()
            .ok_or(AuthError::Unavailable)?,
    )
    .map_err(|_| AuthError::Unavailable)?;
    if pinned.origin() != jwks.origin()
        || !jwks.username().is_empty()
        || jwks.password().is_some()
        || jwks.fragment().is_some()
    {
        return Err(AuthError::Unavailable);
    }
    let set = fetch_json(jwks.as_str()).await?;
    let keys = set["keys"].as_array().ok_or(AuthError::Unavailable)?;
    if keys.is_empty() || keys.len() > MAX_KEYS {
        return Err(AuthError::Unavailable);
    }
    let accepted: Vec<Value> = keys.iter().filter(|k| valid_key(k)).cloned().collect();
    if accepted.is_empty() {
        return Err(AuthError::Unavailable);
    }
    let mut kids = std::collections::BTreeSet::new();
    if accepted
        .iter()
        .any(|key| !kids.insert(key["kid"].as_str().unwrap_or("")))
    {
        return Err(AuthError::Unavailable);
    }
    Ok(accepted)
}

fn valid_key(key: &Value) -> bool {
    key["kty"].as_str() == Some("RSA")
        && key["alg"].as_str() == Some("RS256")
        && key["kid"]
            .as_str()
            .is_some_and(|kid| !kid.is_empty() && kid.len() <= 128)
        && key.get("use").is_none_or(|v| v.as_str() == Some("sig"))
        && key.get("key_ops").is_none_or(|v| {
            v.as_array()
                .is_some_and(|ops| ops.len() == 1 && ops[0].as_str() == Some("verify"))
        })
        && key["n"]
            .as_str()
            .and_then(|n| URL_SAFE_NO_PAD.decode(n).ok())
            .is_some_and(|n| {
                (256..=1024).contains(&n.len()) && n[0] != 0 && (n.len() > 256 || n[0] >= 128)
            })
        && key["e"]
            .as_str()
            .and_then(|e| URL_SAFE_NO_PAD.decode(e).ok())
            .is_some_and(|e| !e.is_empty())
        && ["d", "p", "q", "dp", "dq", "qi", "oth"]
            .iter()
            .all(|field| key.get(field).is_none())
}

async fn fetch_json(url: &str) -> Result<Value, AuthError> {
    let mut init = RequestInit::new();
    init.with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init).map_err(|_| AuthError::Unavailable)?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| AuthError::Unavailable)?;
    if response.status_code() != 200 {
        return Err(AuthError::Unavailable);
    }
    if response
        .headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > 65_536)
    {
        return Err(AuthError::Unavailable);
    }
    let body = response.bytes().await.map_err(|_| AuthError::Unavailable)?;
    if body.len() > 65_536 {
        return Err(AuthError::Unavailable);
    }
    serde_json::from_slice(&body).map_err(|_| AuthError::Unavailable)
}

async fn verify_signature(jwk: &Value, signature: &[u8], data: &[u8]) -> Result<bool, AuthError> {
    let fail = |_| AuthError::Unavailable;
    let crypto = Reflect::get(&js_sys::global(), &"crypto".into())
        .map_err(fail)?
        .dyn_into::<web_sys::Crypto>()
        .map_err(fail)?
        .subtle();
    let key = JSON::parse(&jwk.to_string())
        .map_err(fail)?
        .dyn_into::<Object>()
        .map_err(fail)?;
    let algorithm = web_sys::RsaHashedImportParams::new_with_str("SHA-256");
    Reflect::set(
        algorithm.as_ref(),
        &"name".into(),
        &"RSASSA-PKCS1-v1_5".into(),
    )
    .map_err(fail)?;
    let usages = Array::new();
    usages.push(&"verify".into());
    let imported = JsFuture::from(
        crypto
            .import_key_with_object("jwk", &key, algorithm.as_ref(), false, usages.as_ref())
            .map_err(fail)?,
    )
    .await
    .map_err(fail)?
    .dyn_into::<web_sys::CryptoKey>()
    .map_err(fail)?;
    let verify_algorithm = Object::new();
    Reflect::set(
        &verify_algorithm,
        &"name".into(),
        &"RSASSA-PKCS1-v1_5".into(),
    )
    .map_err(fail)?;
    let verified = JsFuture::from(
        crypto
            .verify_with_object_and_u8_array_and_u8_array(
                &verify_algorithm,
                &imported,
                signature,
                data,
            )
            .map_err(fail)?,
    )
    .await
    .map_err(fail)?;
    Ok(verified.as_bool().unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy() -> ValidationPolicy {
        ValidationPolicy {
            issuer: "https://identity.example".into(),
            audiences: vec!["subscribe".into()],
            token_use: "access".into(),
            nonce: None,
            required_scope: Some("openid".into()),
        }
    }
    fn claims() -> Value {
        json!({"iss":"https://identity.example","sub":"pairwise","aud":"subscribe",
            "iat":900,"exp":1200,"token_use":"access","scope":"openid profile"})
    }
    fn check(c: Value, p: &ValidationPolicy) -> Result<Principal, AuthError> {
        validate_claims(serde_json::from_value(c).unwrap(), p, 1000)
    }

    #[test]
    fn accepts_provider_access_contract() {
        assert_eq!(check(claims(), &policy()).unwrap().subject, "pairwise");
    }
    #[test]
    fn classifies_rejections_without_exposing_claim_values() {
        let mut p = policy();
        p.token_use = "id".into();
        p.nonce = Some("private-transaction-value".into());
        p.required_scope = None;
        let mut c = claims();
        c["token_use"] = json!("id");
        c["nonce"] = json!("private-transaction-value");
        let parsed: Claims = serde_json::from_value(c.clone()).unwrap();
        assert_eq!(claim_rejection_stage(&parsed, &p, 1000), "claims_policy");
        assert!(validate_claims(parsed, &p, 1000).is_ok());
        for (field, value, stage) in [
            ("nonce", json!("different-private-value"), "nonce"),
            ("iss", json!("https://other.example"), "issuer"),
            ("token_use", json!("access"), "token_kind"),
            ("aud", json!("another-client"), "audience"),
            ("iat", json!(1031), "token_time"),
        ] {
            let mut invalid = c.clone();
            invalid[field] = value;
            let parsed: Claims = serde_json::from_value(invalid).unwrap();
            assert_eq!(claim_rejection_stage(&parsed, &p, 1000), stage);
            assert_eq!(
                validate_claims(parsed, &p, 1000),
                Err(AuthError::Unauthorized)
            );
        }
    }
    #[test]
    fn rejects_wrong_identity_kind_audience_and_times() {
        for (field, value) in [
            ("iss", json!("https://other.example")),
            ("aud", json!("account")),
            ("token_use", json!("id")),
            ("exp", json!(970)),
            ("iat", json!(1031)),
            ("nbf", json!(1031)),
            ("sub", json!("")),
            ("client_id", json!("other")),
        ] {
            let mut c = claims();
            c[field] = value;
            assert_eq!(check(c, &policy()), Err(AuthError::Unauthorized), "{field}");
        }
    }
    #[test]
    fn exact_scope_and_id_nonce() {
        let mut c = claims();
        c["scope"] = json!("not-openid");
        assert_eq!(check(c, &policy()), Err(AuthError::Forbidden));
        let mut p = policy();
        p.token_use = "id".into();
        p.nonce = Some("transaction".into());
        p.required_scope = None;
        let mut c = claims();
        c["token_use"] = json!("id");
        assert_eq!(check(c.clone(), &p), Err(AuthError::Unauthorized));
        c["nonce"] = json!("transaction");
        assert!(check(c, &p).is_ok());
    }
    #[test]
    fn rejects_duplicate_security_claims() {
        assert!(serde_json::from_str::<Claims>(r#"{"iss":"one","iss":"two","sub":"s","aud":"a","exp":2,"iat":1,"token_use":"access"}"#).is_err());
    }
    #[test]
    fn key_metadata_cannot_change_algorithm_or_expose_private_key() {
        let mut k = json!({"kty":"RSA","alg":"RS256","kid":"key","n":URL_SAFE_NO_PAD.encode([128;256]),"e":"AQAB"});
        assert!(valid_key(&k));
        k["use"] = json!("enc");
        assert!(!valid_key(&k));
        k["use"] = json!("sig");
        k["d"] = json!("secret");
        assert!(!valid_key(&k));
    }
}
