# Subscribe application boundary

## Decision and ownership

Subscribe is a React application served by a Rust Cloudflare Worker. Its same-origin backend-for-frontend (BFF) owns OAuth transactions and local sessions; Billing owns account/profile, activation and subscription data. The browser never receives OAuth tokens or client assertions. Identity owns authentication and registration; Subscribe never collects passwords or verification codes.

Staging pairing: `https://subscribe-staging.moesegfault.dev` → `https://identity-staging.moesegfault.dev`, client `subscribe-staging`, exact callback `/auth/callback`. Production is independently registered and configured. Deployment owns the confidential client's RSA public registration and ignored private JWK secret. `APP_ORIGIN`, `ISSUER`, and `CLIENT_ID` must never be inferred from browser input.

The current Identity contract uses pairwise subjects and fixes access-token audience to OAuth client ID. Billing therefore accepts explicitly registered client IDs, not a fabricated shared resource audience. Durable user mapping is `(issuer, sub)`. Product/profile email is user-entered billing contact data, not an authenticated email claim.

## Small lifecycle deliberately chosen

1. `/auth/login` stores a ten-minute server-side transaction containing PKCE verifier, random nonce/state and an allowlisted continuation. A separate host-only transaction cookie binds the callback to the initiating browser.
2. Callback consumes the transaction once, requires exact authorization-response issuer and state, exchanges the code using a fresh `private_key_jwt`, and validates the ID token and access token before creating a local session.
3. A random host-only `Secure; HttpOnly; SameSite=Lax` cookie refers to server-side session data. Session expiry cannot exceed its bearer token's expiry.
4. No `offline_access` is requested. This removes rotating refresh races from the initial product rather than introducing special-case recovery. A returning user starts SSO again after expiry. Adding durable refresh later requires per-session serialization and atomic rotation, not a periodic frontend token refresh.
5. Authenticated mutations require exact same-origin `Origin` and session-bound CSRF header. Billing activation also carries a caller-generated idempotency key; retries reuse that key.
6. Local logout deletes session data independently of Identity availability. It does not claim to globally sign out other applications.

## HTTP surface

| Subscribe endpoint | Billing call / result |
| --- | --- |
| `GET /api/session` | `{authenticated, user?:{sub,name?}, csrfToken?, returnTo?}`; never tokens |
| `GET /api/catalog` | `GET /v1/plans`, public catalog |
| `GET /api/billing` | `GET /v1/me` with server-held access token |
| `PUT /api/profile` | `PUT /v1/me/profile`, same-origin CSRF protected |
| `POST /api/activate` | `POST /v1/activations`, CSRF + idempotency protected |
| `POST /auth/logout` | Local session deletion, CSRF protected |

Billing calls use Cloudflare's HTTP service binding, not public-origin forwarding. Browser-provided Authorization and principal headers are not forwarded. Proxy routes are explicit; this is not a general-purpose authenticated URL fetcher. OAuth endpoint errors and Billing problem JSON stay distinct. Correlation IDs are retained without logging tokens, codes, cookies or personal data.

External app return URLs must exactly match `RETURN_URL_ALLOWLIST`. Login redirect URI is always fixed; a return destination is transaction/session state. Login lands on Subscribe first. The UI offers the accepted continuation after successful activation, and does not describe a return URL as proof of payment or entitlement; the requesting application must re-check Billing itself.

## Account section: unavoidable identity distinction

Account's first-party cookie principal ID is not equal to an OAuth pairwise subject. Source: sibling Identity `oauth.rs` constructs subject from sector and principal via HMAC, and explicitly omits internal principal IDs from access tokens. Without a new Identity contract, neither an email join nor a principal query parameter establishes ownership.

Account may embed a read-only Subscribe `/account?embedded=1` view. The viewer explicitly identifies the subscription service account associated with its own Subscribe session; it does not assert equality to Account's first-party session. Signing in/reconnecting is a top-level navigation through `/auth/login`. `frame-ancestors` permits only the environment-paired Account origin. No cross-origin credential/message bridge is introduced.

## Production practice and academic insight

- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) consolidates deployed OAuth failures: PKCE, exact redirects, issuer checks and credential isolation are controls, not optional decorations.
- [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017) describes the confidential BFF pattern: keep tokens server-side and proxy explicit business operations. BFF does not eliminate same-origin XSS, so CSP, no third-party scripts and semantic UI still matter.
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) defines ID-token validation and pairwise subject semantics. Billing contact fields must not be promoted into authentication claims.
- [Cloudflare HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) keep inter-worker calls explicit. [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) support SQLite-backed state; single-use login claims require a conditional atomic database operation rather than an in-memory check.
- Fett, Küsters and Schmitz, [A Comprehensive Formal Security Analysis of OAuth 2.0](https://arxiv.org/abs/1601.01229), shows why authentication, authorization and session integrity are separate properties. The practical lesson is to test browser transaction binding and account confusion, not merely signature acceptance. This paper predates the current BCP; it motivates invariants but is not copied as a contemporary deployment recipe.

The useful next validation is one actual staging browser journey from application request to Identity registration, mail receipt, profile save, activation and reloaded entitlement. Focused adversarial checks target transaction replay, CSRF, wrong audience/issuer and external return URL rejection; repeated full matrix builds add less value than exercising the environment boundary.

## Cheap persistence validation

`node --test scripts/tests/subscribe-store.test.mjs` runs three tests against the actual Worker SQL extracted from `store.rs` and the checked-in session migration. Node SQLite uses an in-memory database, no dev server or credentials. Initial result: 3/3 passed in approximately 68 ms on Node 26.10.0. The checks establish browser-bound single-use consumption, exact expiry rejection, and session hash/expiry ownership. They do not substitute for D1 platform acceptance during the real callback.

The fixture uses explicit column names so additive display-profile fields cannot silently shift session values. It also verifies the trusted display name readback. The BFF independently passed six native boundary tests and a `wasm32-unknown-unknown` compile check using two Cargo jobs and the shared repository `.cache/cargo-target`. The final staging callback/activation acceptance remains owned by the integrated browser/mail run.

The current Identity signer includes standard `name` and `preferred_username` in ID tokens when `profile` scope is granted. Subscribe reads these only after verifying the exact ID token and stores a bounded optional display name. This is a useful label for the separately authenticated Account iframe; it is never an authorization key and never comes from the self-declared billing profile.

## First staging runtime correction: asset response ownership

The initial staging deployment returned JSON 200 for `/healthz`, `/api/catalog` and `/api/session`, but raw HTTP 500 for `/` and `/index.html`. The difference isolated the failure to the ASSETS passthrough: the entrypoint added security headers to the fetched asset response, whose platform Headers guard is immutable.

The asset boundary now clones its headers and installs that new Headers object on the same owned response before returning it. In worker 0.8.6, `Headers::clone` invokes `web_sys::Headers::new_with_headers`, creating mutable platform headers. `Response::with_headers` replaces only builder headers; body stream, status, encoding and cache metadata are retained without buffering or duplicating the body. This follows [Cloudflare's modify-response practice](https://developers.cloudflare.com/workers/examples/modify-response/).

Focused validation after the correction: formatting passed; WASM cargo check completed in 0.53 seconds; six native boundary tests passed after 2.48 seconds incremental compilation, using two jobs and the existing repository cache. These tests cannot recreate Cloudflare's immutable fetched header guard; final runtime acceptance is a fresh staging `/` and `/index.html` response with HTML content and the environment-paired framing CSP after the hosted rebuild/deploy.

Runtime acceptance completed on the repaired staging version `15520137-1a13-45d5-8414-643b53171bbe`: `/`, `/index.html` and `/account?embedded=1` each returned HTTP 200 with HTML content and the paired Account `frame-ancestors` policy; the JavaScript asset returned HTTP 200. Deployment smoke also passed guest session/catalog and unauthenticated personal-API boundaries. The full user registration/profile/activation browser journey is a separate integration acceptance step, not implied by this static runtime repair.

## OAuth failure recovery

A real registered-user SSO attempt reached Subscribe's callback but failed ID-token verification. The verifier's strict checks remain intact; categorical, credential-free diagnostics in the shared Billing verifier are used to locate the exact interoperability failure before changing policy.

Top-level OAuth callbacks no longer strand users on problem JSON. A failed consumed transaction returns HTTP 303 to its original safe local UI path and a revalidated allowlisted continuation, using only `auth_error=login_failed` or `login_denied`. Invalid or missing transactions return to the fixed home page. No authorization response code, state, issuer, token, raw error description, or arbitrary URL enters the recovery link. The transaction cookie is cleared. The frontend localizes the two categories and offers explicit retry; it never automatically repeats login. If a previous application session is still valid, the notice states that the displayed subscriptions still belong to the previously signed-in account.

Focused checks: seven Subscribe native tests including same-origin recovery/context rejection; WASM compilation; sixteen frontend tests including category allowlisting, retry context and old-session warning, plus TypeScript/production build. These checks validate recovery without treating the unresolved token interoperability failure as a successful login.

The verifier interoperability cause was subsequently isolated to `RequestRedirect::Error`, which workerd rejects when constructing the discovery fetch request. Shared verification now uses `Manual` and still requires HTTP 200, rejecting redirects without following them. JWT signature, issuer, audience, kind and nonce checks remain unchanged. `scripts/auth-runtime.test.mjs` reproduces the behavior in actual workerd and passed in approximately 0.58 seconds. A fresh staged SSO attempt remains the end-to-end confirmation.

## Application continuation and bounded session expiry

The subsequent real staging browser run successfully established SSO, read Billing and saved a billing profile. A later activation returned HTTP 401 after the provider's actual 300-second access-token lifetime. This is expected enforcement, not grounds to stretch token expiry or add an unapproved refresh scope.

That run exposed a useful UX defect: the successful callback had retained `return_to` only in server-side session state, so an expired session's login retry could lose the application continuation. Successful and failed callbacks now share the same portal-destination builder, which appends only the revalidated allowlisted continuation to the product URL. Authorization response fields never enter that URL. Eight focused Rust tests, including success continuation preservation and rejected unregistered destinations, plus WASM checking passed using the shared incremental cache.

The React application treats an HTTP 401 from any protected operation as a centralized session-expiry boundary: discard local authenticated state and loaded personal Billing content, remove privileged forms, and offer explicit sign-in with the retained application context. Other failures such as CSRF 403 or profile validation do not silently replace the user's account or initiate automatic OAuth loops. Provider TTL and no-refresh policy remain unchanged.

The focused frontend expiry changes passed eighteen tests in approximately 312 ms plus TypeScript and production build checks; the embedded Account view uses the same recovery boundary. No development server or refresh-token feature was added.
