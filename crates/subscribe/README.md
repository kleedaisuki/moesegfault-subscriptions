# Subscribe BFF

Rust Worker entrypoint (`src/lib.rs`) serves React assets and a deliberately small
same-origin API. `SESSIONS` is D1; `BILLING` is a private service binding; `ASSETS`
is the static assets fetcher. Required public variables: `ISSUER`, `CLIENT_ID`,
`CLIENT_KEY_ID`, `APP_ORIGIN`, `ACCOUNT_ORIGIN`, `RETURN_URL_ALLOWLIST` (JSON array).
`CLIENT_PRIVATE_KEY_JWK` is a Worker secret containing the private RSA JWK registered
with Identity. Never publish this secret, tokens, callbacks, or session contents.

## Browser API

- `GET /auth/login?path=/`: authorization-code login with S256 PKCE, nonce, and
  browser-bound server-side state. `path` may only be `/` or `/account`.
  Optional `return_to` is an exact allowlisted HTTPS continuation or safe local
  path. Optional `locale` (`zh-CN`, `en`, `ja`) and `theme` (`light`, `dark`) survive
  authentication. External continuation is shown by the UI only after activation;
  it is never the OAuth callback or immediate post-authentication redirect.
  Bounded `app` and `plan` hints are preserved as local UI context, not authorization.
- `GET /auth/callback`: validates `state`, `iss`, browser cookie, ID-token nonce,
  both token kinds and subjects. State is consumed with one atomic D1
  `DELETE ... RETURNING`. Failed exchanges require a fresh login, not retries.
- `GET /api/session`: `{authenticated:false}` or
  `{authenticated:true,csrfToken,user:{sub,name},returnTo}`. `name` is optional,
  derived only from standard claims in the verified ID token. No OAuth token is
  returned. A valid current `return_to` request parameter overrides a previous
  session continuation; invalid continuations are rejected even when signed in.
- `GET /api/catalog`: public Billing plan registry.
- `GET /api/billing`: current account and subscriptions.
- `PUT /api/profile`: JSON BillingProfile replacement.
- `POST /api/activate`: `{code}`, JSON plus `Idempotency-Key` (8–128 printable
  non-space ASCII characters). Retrying a request must reuse its key.
- `POST /auth/logout`: deletes only this application's local session; returns
  `{ok:true}`. It does not claim Identity-wide logout.

All mutations require exact `Origin: APP_ORIGIN` and `X-CSRF-Token` from
`/api/session`. Request body streaming stops at 16 KiB, irrespective of declared
Content-Length. Browser authorization and user identity headers are discarded;
only the stored server-side access token is sent to Billing. Billing problem
responses remain intact, including `x-moesegfault-correlation-id`.

## Session lifecycle and compatibility

Secure HttpOnly host-only SameSite=Lax cookies contain 256-bit opaque entropy;
only SHA-256 cookie digests index D1 records. Login state and its browser-bound cookie
expire together after thirty minutes, covering Identity's bounded email-registration
flow without extending any authenticated token or session lifetime.
Sessions expire at the earliest of ID-token expiry, access-token expiry, and
30 minutes. No `offline_access`, refresh token, or token rotation is implemented.
Reconnect uses `/auth/login?path=/account`; authentication replaces any previous
browser session. Expired records are cleaned with indexed expiry predicates at
login. Existing Identity endpoints, registrations, and account service behavior
remain unchanged.

`ACCOUNT_ORIGIN` must be an exact HTTPS origin. CSP permits framing only by self
and that origin; scripts, styles, fonts and connections are same-origin. Assets
must not depend on remote CDNs or inline scripts/styles. API, authentication, error
and redirect responses are non-cacheable; successful static responses retain the
asset binding's cache policy for efficient delivery of hashed bundles.

## Validation and references

Native unit tests cover redirect rejection, exact external allowlists, duplicate
callback parameters, bounded idempotency keys, exact Origin/session-bound CSRF,
and credential-bounded session expiry.
Workers runtime/staging tests must additionally cover WebCrypto signing, D1 atomic
callback replay, session cookies, CSRF and the full Identity-to-Billing chain.

- [Cloudflare Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)
- [OAuth Security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OAuth for Browser-Based Applications, RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html)
- [Identity integration skill](../../.agents/skills/moesegfault-identity/SKILL.md)
