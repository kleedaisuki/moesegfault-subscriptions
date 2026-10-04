//! Deployment-owned plans and validated, self-declared billing information.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use worker::{Env, Error, Result};

/// A versioned plan; issuing a code snapshots its grant, so later edits do not revoke it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    /// Stable deployment-owned plan identifier.
    pub id: String,
    /// Product entitlement namespace and subscription uniqueness key.
    pub product_id: String,
    /// Human-readable names for the three supported locales.
    pub name: BTreeMap<String, String>,
    /// Short, useful localized plan descriptions.
    pub description: BTreeMap<String, String>,
    /// Whole-day grant duration, bounded to ten years.
    pub duration_days: u32,
    /// Whether new activation codes may be issued.
    pub active: bool,
    /// Application-consumable entitlement names.
    pub entitlements: Vec<String>,
}

/// Mutable invoice/contact details; these are never trusted as verified identity claims.
#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BillingProfile {
    /// Invoice recipient's display name, not an authentication identifier.
    pub display_name: Option<String>,
    /// Self-declared billing contact, not a verified Identity email address.
    pub email: Option<String>,
    /// ISO 3166 alpha-2 country code.
    pub country: Option<String>,
    /// Primary postal address line.
    pub address_line1: Option<String>,
    /// Optional second postal address line.
    pub address_line2: Option<String>,
    /// Postal municipality.
    pub city: Option<String>,
    /// Country-specific postal code.
    pub postal_code: Option<String>,
    /// Optional self-declared tax identification number.
    pub tax_id: Option<String>,
}

impl BillingProfile {
    /// Normalizes empty strings and rejects unbounded or misleading contact data.
    pub fn normalize(mut self) -> std::result::Result<Self, &'static str> {
        for field in [
            &mut self.display_name,
            &mut self.email,
            &mut self.country,
            &mut self.address_line1,
            &mut self.address_line2,
            &mut self.city,
            &mut self.postal_code,
            &mut self.tax_id,
        ] {
            *field = field
                .take()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty());
            if field
                .as_ref()
                .is_some_and(|v| v.len() > 254 || v.chars().any(char::is_control))
            {
                return Err("invalid_profile");
            }
        }
        if self.email.as_ref().is_some_and(|v| {
            let parts: Vec<_> = v.split('@').collect();
            parts.len() != 2
                || parts[0].is_empty()
                || !parts[1].contains('.')
                || v.chars().any(char::is_whitespace)
        }) {
            return Err("invalid_email");
        }
        if let Some(country) = &mut self.country {
            country.make_ascii_uppercase();
            if country.len() != 2 || !country.bytes().all(|c| c.is_ascii_uppercase()) {
                return Err("invalid_country");
            }
        }
        Ok(self)
    }
}

/// Parses and validates the registry once per request, failing closed on bad deployment data.
pub fn registry(env: &Env) -> Result<Vec<Plan>> {
    let raw = env.var("PLAN_REGISTRY_JSON")?.to_string();
    parse_registry(&raw).map_err(|_| Error::RustError("invalid_plan_registry".into()))
}

/// Validates registry identifiers, localization, bounded grants, and uniqueness.
pub fn parse_registry(raw: &str) -> std::result::Result<Vec<Plan>, &'static str> {
    let plans: Vec<Plan> = serde_json::from_str(raw).map_err(|_| "invalid_plan_registry")?;
    let mut ids = HashSet::new();
    if plans.is_empty() || plans.len() > 100 {
        return Err("invalid_plan_registry");
    }
    for plan in &plans {
        if !identifier(&plan.id)
            || !identifier(&plan.product_id)
            || !ids.insert(&plan.id)
            || !(1..=3650).contains(&plan.duration_days)
            || plan.entitlements.len() > 50
            || !plan.entitlements.iter().all(|e| identifier(e))
        {
            return Err("invalid_plan_registry");
        }
        for locale in ["zh-CN", "en", "ja"] {
            if plan
                .name
                .get(locale)
                .is_none_or(|v| v.is_empty() || v.len() > 256)
                || plan.description.get(locale).is_none_or(|v| v.len() > 2048)
            {
                return Err("invalid_plan_registry");
            }
        }
    }
    Ok(plans)
}

/// Stable restricted identifiers cannot become URLs, SQL fragments, or ambiguous namespaces.
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}

/// SHA-256 identifiers hide high-entropy credentials at rest, without a password KDF.
pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

/// Generates 192-bit URL-safe credentials using the runtime CSPRNG.
pub fn random_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::RustError("random_failed".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Runtime clock in Unix seconds; persisted timestamps use this single representation.
pub fn now() -> i64 {
    (worker::Date::now().as_millis() / 1000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_clears_and_normalizes_without_claiming_verification() {
        let profile = BillingProfile {
            display_name: Some("  ".into()),
            country: Some(" cn ".into()),
            email: Some(" klee@example.com ".into()),
            ..Default::default()
        }
        .normalize()
        .unwrap();
        assert_eq!(profile.display_name, None);
        assert_eq!(profile.country.as_deref(), Some("CN"));
        assert_eq!(profile.email.as_deref(), Some("klee@example.com"));
    }
    #[test]
    fn rejects_control_characters_and_invalid_email() {
        assert!(
            BillingProfile {
                email: Some("a@b".into()),
                ..Default::default()
            }
            .normalize()
            .is_err()
        );
        assert!(
            BillingProfile {
                city: Some("x\ny".into()),
                ..Default::default()
            }
            .normalize()
            .is_err()
        );
    }
}
