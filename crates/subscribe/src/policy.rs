//! Pure boundary rules shared by handlers and native tests.

/// Accept a local destination without URL-parser normalization surprises.
pub fn local_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains(['\\', '\r', '\n', '#'])
        && !value.bytes().any(|b| b < 32 || b == 127)
        && !value.to_ascii_lowercase().contains("%5c")
        && !value.to_ascii_lowercase().contains("%2f")
}

/// External continuations are exact registered HTTPS URLs, never origin wildcards.
pub fn return_allowed(value: &str, allowlist: &[String]) -> bool {
    if local_path(value) {
        return true;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && allowlist.iter().any(|v| v == value)
}

/// Idempotency keys are opaque printable ASCII, bounded to avoid header/storage abuse.
pub fn idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.bytes().all(|b| (33..=126).contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_redirects_reject_authority_and_encoded_slashes() {
        for path in ["//evil.test", "/\\evil", "/%2Fevil", "/%5cevil", "/\nevil"] {
            assert!(!local_path(path), "{path:?}");
        }
        assert!(local_path("/account?locale=ja"));
    }
    #[test]
    fn external_continuations_require_exact_registration() {
        let list: Vec<String> = vec!["https://account.example/subscriptions".into()];
        assert!(return_allowed(&list[0], &list));
        assert!(!return_allowed(
            "https://account.example/subscriptions?next=evil",
            &list
        ));
        assert!(!return_allowed(
            "https://account.example.evil/subscriptions",
            &list
        ));
        assert!(!return_allowed("javascript:alert(1)", &list));
        assert!(!return_allowed(
            "https://user@account.example/subscriptions",
            &list
        ));
        assert!(!return_allowed(
            "https://account.example/subscriptions#fragment",
            &list
        ));
    }
    #[test]
    fn idempotency_is_bounded() {
        assert!(idempotency_key("activation-123"));
        assert!(!idempotency_key("short"));
        assert!(!idempotency_key("bad key 123"));
    }
}
