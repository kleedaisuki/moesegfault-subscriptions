# Billing authentication boundary

Billing is a resource service, not an authentication provider. Callers authenticate
users with Identity and send the resulting access token as a Bearer credential.
No Identity cookie, account email, ID token, or unregistered resource audience is
accepted as authorization. The domain identity is `(issuer, subject)`.

## Deployment contract

- `IDENTITY_ISSUER`: exact environment-specific HTTPS issuer.
- `BILLING_AUDIENCES`: JSON array of exact registered OAuth client IDs. Current
  Identity access tokens use the originating client ID as their audience.
- Subscribe and Account clients must be registered in the same pairwise-subject
  sector before both audiences are accepted. Merely adding another audience does
  not make subjects from distinct sectors joinable. Do not join by email.
- Discovery must return the exact configured issuer. The advertised JWKS URL
  must stay on the issuer origin, without embedded credentials. HTTP redirects
  are rejected. No token-supplied key URL or alternate environment is consulted.

## Verification policy

The current Identity signer emits `alg=RS256`, `typ=JWT`, and `token_use=access`
or `token_use=id`. Billing requires the access discriminator and an exact
`openid` scope. Subscribe reuses `auth::verify_token` for ID-token validation,
with the stored nonce and `token_use=id`; callback policy must supply a nonce.

Signature verification uses Cloudflare Workers WebCrypto's RSA PKCS#1 v1.5
SHA-256 operation. JWT framing and claim checks are explicit Rust code; no
cryptographic primitives are implemented locally. Parsed fields are not exposed
until signature verification succeeds. Security-relevant duplicate JSON fields
are rejected through typed Serde deserialization.

Validation checks issuer, subject, exact accepted audience, token kind, expiry,
issued-at, optional not-before, nonce where required, and required scope. Clock
skew is 30 seconds. Multi-audience access tokens are not the provider contract
and are rejected; multi-audience ID tokens require a matching authorized party.
JWKs must be public RSA signing keys declaring RS256 with 2048–8192-bit-sized
moduli and compatible key usage. Unknown critical JWT extensions are rejected.

## Cache and failure behavior

An isolate-local cache holds at most four pinned issuers and 32 keys per issuer.
Successful discovery/JWKS refreshes are cached for five minutes. Unknown-key
refreshes are shared by concurrent requests and throttled to once per 30 seconds,
including failures. Old public keys remain only within a bounded window covering
Identity's current maximum 300-second token lifetime and clock skew. Refreshes
never trust a stale discovery issuer or redirect to a new trust domain.

Tokens are limited to 16 KiB and fetched metadata to 64 KiB. Fetch failures produce
`Unavailable`; invalid credentials produce `Unauthorized`; missing scope produces
`Forbidden`; malformed deployment policy produces `Configuration`. These categories
contain no raw tokens or user identifiers. Signature cryptography is exercised in
the Workers runtime; native unit tests cover claims, nonce, scopes, duplicate claims,
and JWK metadata policy without calling JavaScript APIs.

Access tokens remain valid until expiry despite refresh-token revocation: Identity
does not currently expose introspection. Do not promise immediate global logout.

## Staging interoperability diagnostics

On 2026-10-05 the real Subscribe callback reached token exchange but rejected its
ID token. The checked-in Identity signer and public staging discovery/JWKS were
compared with the consumer: `JWT` / `RS256`, `token_use=id`, original nonce, exact
issuer, same-origin JWKS, and a valid 2048-bit RSA signing JWK all match. Therefore
removing nonce, token-kind, or signature requirements is not an acceptable repair.

When `ENVIRONMENT=staging`, rejected verification now emits only categorical
constants (`identity_verification_rejected stage=... category=...`). Stages separate
framing/schema, issuer, token kind, time, nonce, audience, scope, key discovery,
platform cryptography, and signature mismatch. No token, claim value, subject,
authorization code, or key is formatted. Production emits none of these diagnostics.
Inspect only the matching console log messages from tail JSON; never print complete
callback request URLs because their query includes one-use credentials.

The diagnostic classifier has a focused regression test retaining all acceptance
rules. `cargo +stable check -p billing --target wasm32-unknown-unknown --locked -j 2`
passed locally using the repository `.cache/cargo-target` directory. The next probe
is one fresh staging authorization flow and its categorical rejection, followed by
a concrete consumer repair if warranted; diagnosis alone is not closed-loop success.

## References and rationale

- [Workers WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/):
  use the platform's maintained cryptography rather than ship custom RSA/Wasm math.
- [JWT Best Current Practices, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html):
  pin algorithms, validate issuer and audience, and distinguish token contexts.
- [Identity integration skill](../.agents/skills/moesegfault-identity/SKILL.md):
  local provider contract, caller models, subject sectors, and integration references.
- Provider implementation: sibling repository
  `crates/identity-worker/src/oauth.rs` (`issue_tokens`, `access_claims`, `pairwise`)
  and `src/webcrypto.rs`. Current access/ID lifetime is capped at 300 seconds.
