//! Platform WebCrypto signing; no RSA implementation or browser token handling.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use js_sys::{Array, JSON, Object, Reflect, Uint8Array};
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{Error, Result};

/// Produce 256 bits of entropy for cookies, state, nonce, PKCE, and assertion IDs.
pub fn random() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::RustError("entropy unavailable".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Digest opaque secrets before indexing persistent records; also implements S256 PKCE.
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

/// Sign a fresh short-lived client assertion with the deployment-owned private RSA JWK.
pub async fn assertion(env: &worker::Env, endpoint: &str, now: i64) -> Result<String> {
    let client = env.var("CLIENT_ID")?.to_string();
    let header =
        serde_json::json!({"alg":"RS256","typ":"JWT","kid":env.var("CLIENT_KEY_ID")?.to_string()});
    let claims = serde_json::json!({"iss":client,"sub":client,"aud":endpoint,"iat":now,"exp":now+120,"jti":random()?});
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?)
    );
    let jwk: Object =
        JSON::parse(&env.secret("CLIENT_PRIVATE_KEY_JWK")?.to_string())?.dyn_into()?;
    let algorithm = JSON::parse(r#"{"name":"RSASSA-PKCS1-v1_5","hash":"SHA-256"}"#)?;
    let usages = Array::new();
    usages.push(&JsValue::from_str("sign"));
    let crypto: web_sys::Crypto =
        Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))?.dyn_into()?;
    let key: web_sys::CryptoKey = JsFuture::from(crypto.subtle().import_key_with_object(
        "jwk",
        &jwk,
        &algorithm.into(),
        false,
        &usages,
    )?)
    .await?
    .dyn_into()?;
    let signed = JsFuture::from(crypto.subtle().sign_with_str_and_u8_array(
        "RSASSA-PKCS1-v1_5",
        &key,
        input.as_bytes(),
    )?)
    .await?;
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(Uint8Array::new(&signed).to_vec())
    ))
}

/// Read expiration only after a verifier has established trust in this exact token.
pub fn verified_exp(token: &str) -> Result<i64> {
    let claims = verified_claims(token)?;
    claims["exp"]
        .as_i64()
        .ok_or_else(|| Error::RustError("invalid token expiry".into()))
}

/// Decode standard claims only after verifying this exact compact token.
pub fn verified_claims(token: &str) -> Result<serde_json::Value> {
    let part = token
        .split('.')
        .nth(1)
        .ok_or_else(|| Error::RustError("invalid token".into()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| Error::RustError("invalid token".into()))?;
    Ok(serde_json::from_slice(&bytes)?)
}
