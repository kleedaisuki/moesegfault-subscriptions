//! Email-only administrator issuance with immutable intents and fail-closed send recovery.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::{domain, problem};

/// Narrow issuance input: recipients and sender are never caller-controlled.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    /// Registered deployment-owned plan identifier.
    plan_id: String,
}

/// Persisted receipt contains no plaintext activation capability or email address.
#[derive(Deserialize)]
struct Receipt {
    /// Immutable request identifier used for local recovery.
    issuance_id: String,
    /// Original plan identifier, enforcing retry parameter equality.
    plan_id: String,
    /// Hash of the secret generation key, detecting rotation during unresolved sends.
    key_fingerprint: String,
    /// Pending, sending, provider-accepted, or ambiguous outcome.
    status: String,
}

/// Derive one opaque, high-entropy capability per immutable intent and plan.
fn capability(key: &str, id: &str, plan: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts arbitrary key lengths");
    mac.update(b"moesegfault.billing.activation.v1\0");
    mac.update(id.as_bytes());
    mac.update(b"\0");
    mac.update(plan.as_bytes());
    format!(
        "msf_{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// Accept only canonical UUIDv4 intents; arbitrary attacker-selected structured keys are rejected.
fn valid_intent(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(i, value)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *value == b'-'
            } else {
                value.is_ascii_digit() || (b'a'..=b'f').contains(value)
            }
        })
}

/// Load one receipt after a database-arbitrated create or send claim.
async fn receipt(db: &D1Database, id: &str) -> Result<Receipt> {
    db.prepare("SELECT issuance_id,plan_id,key_fingerprint,status FROM admin_issuance WHERE issuance_id=?1")
        .bind(&[id.into()])?.first(None).await?
        .ok_or_else(|| Error::RustError("issuance_unavailable".into()))
}

/// Expose only a non-secret receipt; an interrupted sending state is deliberately ambiguous.
fn response(row: Receipt) -> Result<Response> {
    let status = if row.status == "sending" {
        "unknown"
    } else {
        &row.status
    };
    Response::from_json(&serde_json::json!({"issuance_id":row.issuance_id,"status":status}))
}

/// Issue and send once. Provider/database atomicity is impossible, so unknown outcomes never resend.
pub async fn issue(req: &mut Request, env: &Env) -> Result<Response> {
    let key = env.secret("BILLING_ADMIN_KEY")?.to_string();
    let presented = req.headers().get("Authorization")?.unwrap_or_default();
    let expected = format!("Bearer {key}");
    if key.len() < 32 || !bool::from(presented.as_bytes().ct_eq(expected.as_bytes())) {
        return problem(
            401,
            "invalid_admin_key",
            "Administrator authentication required",
        );
    }
    let id = req.headers().get("Idempotency-Key")?.unwrap_or_default();
    if !valid_intent(&id) {
        return problem(
            400,
            "invalid_idempotency_key",
            "Use a UUIDv4 issuance intent",
        );
    }
    let input: Input = match crate::read_json(req).await {
        Ok(input) => input,
        Err(_) => return problem(400, "invalid_request", "Specify a registered plan"),
    };
    let fingerprint = domain::hash(&key);
    let db = env.d1("BILLING_DB")?;
    let found = db.prepare("SELECT issuance_id,plan_id,key_fingerprint,status FROM admin_issuance WHERE issuance_id=?1")
        .bind(&[id.clone().into()])?.first::<Receipt>(None).await?;
    if let Some(row) = found {
        if row.plan_id != input.plan_id {
            return problem(
                409,
                "idempotency_conflict",
                "Intent belongs to a different plan",
            );
        }
        if row.status != "pending" {
            return response(row);
        }
        if row.key_fingerprint != fingerprint {
            return problem(
                409,
                "issuance_key_rotated",
                "Reconcile this intent before retrying",
            );
        }
    } else {
        if !domain::registry(env)?
            .iter()
            .any(|p| p.id == input.plan_id && p.active)
        {
            return problem(400, "invalid_plan", "Choose an available plan");
        }
        create(env, &db, &id, &input.plan_id, &key, &fingerprint).await?;
        let row = receipt(&db, &id).await?;
        if row.plan_id != input.plan_id || row.key_fingerprint != fingerprint {
            return problem(
                409,
                "idempotency_conflict",
                "Intent belongs to a different issuance",
            );
        }
    }
    // Preflight configuration before taking the irreversible send claim.
    let recipient = destination(env)?;
    let email = env.send_email("EMAIL")?;
    let code = capability(&key, &id, &input.plan_id);
    let text = format!(
        "moeSegFault subscription activation\n\nPlan: {}\nActivation code: {}\n\nOpen Subscribe and enter this code. This code grants one subscription and expires 30 days after issuance. Keep it private.\n",
        input.plan_id, code
    );
    let sender = EmailAddress::new("moeSegFault Subscribe", "subscribe@moesegfault.dev");
    let message = SendEmailBuilder::builder_with_email_address_and_str(
        &sender,
        &recipient,
        "moeSegFault subscription activation",
    )
    .text(&text)
    .build();
    let claim = db.prepare("UPDATE admin_issuance SET status='sending',updated_at=?2 WHERE issuance_id=?1 AND status='pending' AND key_fingerprint=?3 RETURNING issuance_id")
        .bind(&[id.clone().into(), JsValue::from_f64(domain::now() as f64), fingerprint.into()])?
        .first::<serde_json::Value>(None).await?;
    if claim.is_none() {
        return response(receipt(&db, &id).await?);
    }
    let status = if email.send_with_builder(&message).await.is_ok() {
        "sent"
    } else {
        "unknown"
    };
    db.prepare("UPDATE admin_issuance SET status=?2,updated_at=?3 WHERE issuance_id=?1 AND status='sending'")
        .bind(&[id.clone().into(), status.into(), JsValue::from_f64(domain::now() as f64)])?.run().await?;
    response(receipt(&db, &id).await?)
}

/// Reject missing or header-bearing administrator addresses before minting an activation.
fn destination(env: &Env) -> Result<String> {
    let recipient = env.secret("ADMIN_EMAIL")?.to_string();
    if recipient.len() > 254
        || recipient
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
        || recipient.matches('@').count() != 1
        || recipient.starts_with('@')
        || recipient.ends_with('@')
    {
        return Err(Error::RustError("invalid_admin_email_configuration".into()));
    }
    Ok(recipient)
}

/// Snapshot a registered grant once. D1 batches prevent races from creating orphan capabilities.
async fn create(
    env: &Env,
    db: &D1Database,
    id: &str,
    plan_id: &str,
    key: &str,
    fingerprint: &str,
) -> Result<()> {
    destination(env)?;
    env.send_email("EMAIL")?;
    let plan = domain::registry(env)?
        .into_iter()
        .find(|p| p.id == plan_id && p.active)
        .ok_or_else(|| Error::RustError("invalid_plan".into()))?;
    let hash = domain::hash(&capability(key, id, plan_id));
    let now = domain::now();
    db.batch(vec![
        db.prepare("INSERT INTO activation_codes(code_hash,plan_id,product_id,duration_seconds,entitlements_json,created_at,expires_at) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE NOT EXISTS(SELECT 1 FROM admin_issuance WHERE issuance_id=?8)")
            .bind(&[hash.clone().into(),plan_id.into(),plan.product_id.into(),JsValue::from_f64(f64::from(plan.duration_days)*86400.0),serde_json::to_string(&plan.entitlements)?.into(),JsValue::from_f64(now as f64),JsValue::from_f64((now+30*86400) as f64),id.into()])?,
        db.prepare("INSERT OR IGNORE INTO admin_issuance(issuance_id,plan_id,code_hash,key_fingerprint,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)")
            .bind(&[id.into(),plan_id.into(),hash.into(),fingerprint.into(),JsValue::from_f64(now as f64)])?,
    ]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_preserves_retry_and_separates_intents() {
        let a = capability("test key", "intent-a", "pro");
        assert_eq!(a, capability("test key", "intent-a", "pro"));
        assert_ne!(a, capability("test key", "intent-b", "pro"));
        assert_ne!(a, capability("test key", "intent-a", "basic"));
        assert_ne!(a, capability("rotated key", "intent-a", "pro"));
        assert_eq!(a.len(), 47);
    }

    #[test]
    fn only_canonical_uuid_v4_is_accepted() {
        assert!(valid_intent("11111111-1111-4111-8111-111111111111"));
        assert!(!valid_intent("11111111-1111-1111-8111-111111111111"));
        assert!(!valid_intent("../../secret"));
    }
}
