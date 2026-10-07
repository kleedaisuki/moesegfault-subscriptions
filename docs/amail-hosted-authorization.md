# amail hosted authorization

## Scope and contract (2026-10-07)

Subscribe owns human consent, Billing owns account binding and entitlements, and amail owns its agent credentials. No Identity changes are needed or made. The browser never receives amail credentials or OAuth access tokens. Existing product portal and account embedding remain unchanged.

Machine callers create an authorization through Billing. They open the returned hosted URL `/amail/authorize/OPAQUE`. Subscribe requires its existing server-held OAuth session, preserving the opaque authorization ID across top-level login and session expiry. Cookie-bound PKCE/OIDC state remains the authentication boundary; the opaque ID is not an authentication session.

Explicit BFF mappings:

| Browser endpoint | Billing endpoint | Protection |
| --- | --- | --- |
| GET `/api/amail/authorizations/{id}` | GET `/v1/authorizations/{id}` | Existing authenticated session |
| POST `.../{id}/approve` | POST `.../{id}/approve` | Session + exact Origin + session-bound CSRF |
| POST `.../{id}/cancel` | POST `.../{id}/cancel` | Session + exact Origin + session-bound CSRF |

The opaque ID accepts only 24–128 ASCII base64url characters. Arbitrary suffixes, alternate methods and nested routes are not proxied. JSON bodies retain the existing 16 KiB streaming limit. Browser-supplied Authorization headers are discarded.

Approval payload is `{acknowledge:true,plan_id,overage_budget_micros}`. Human choices override the agent's proposed defaults. Budget is decimal CNY with at most two decimal digits, converted exactly into integer micros (`1 CNY = 1,000,000 micros`); zero disables overage. The consent checkbox resets after plan or budget changes. All authorization-changing logic, budget limits and active paid subscription checks remain authoritative in Billing.

The UI shows Free/Lite/Plus, the current Billing payer, explicit account-binding consent, package quantities and overage prices. Paid plans reuse the existing activation-code form, retaining its stable idempotency key. Activation does not automatically approve binding: the human must click consent afterwards. The displayed copy explicitly states that usage accrues pending settlement and no automatic monetary payment is processed. Cancellation and expired/approved states are separate.

The only completion link currently accepted is exactly `https://amail-staging.moesegfault.dev/billing/return`, without added query or fragment. Completion is explicit navigation, never an automatic redirect or proof of payment. amail must poll its server-side Billing result. Production completion must be explicitly added when production is in scope.

## Privacy and observability

The hosted route and all APIs are `Cache-Control: no-store`, with existing no-referrer, CSP, token isolation and no third-party scripts. IDs stay in memory and the hosted URL path; they are not written into local/session storage or analytics. Wrangler must keep query redaction enabled and invocation URL logging disabled because the authorization ID is private and occurs in the path. Operational infrastructure must not introduce raw URL/access logs on authorization API paths either.

Browser API requests generate a memory-only page trace ID and a fresh W3C client span per request. Subscribe validates version-00 `traceparent`, lowercase hex and nonzero IDs, creates a fresh server span, and creates another child span for Billing. Invalid contexts start a fresh trace. Arbitrary baggage/tracestate is not forwarded. Subscribe stores only the closed 12-field envelope in typed D1 columns: schema_version, event_id (UUIDv4), service, operation, phase, trace_id, span_id, parent_span_id, occurred_at_ms, duration_ms, outcome and http_status. Request and dependency spans use request_exit and dependency_exit phases. Writes are best-effort and cannot change a committed business result. No console log fallback exists. Neither opaque authorization IDs, query strings, payer identifiers, OAuth codes, cookies nor bodies are logged. This is structured trace-correlated telemetry, not an OTLP exporter.

Standards checked: [W3C Trace Context](https://www.w3.org/TR/trace-context/) for propagation and privacy, and [OAuth security BCP RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) for exact destinations and CSRF. The existing Subscribe BFF documentation captures production OAuth design choices and the relevant formal/academic security background; this implementation reuses that boundary rather than adding a second authentication mechanism.

## Verification

- `cargo test -p subscribe`: 12 native tests passed, including proxy allowlist, CSRF, safe login recovery, authorization context preservation and telemetry label redaction.
- `npm test`: 24 tests passed, including new opaque ID, exact decimal budget, fixed completion URL and safe payer/settlement rendering tests; existing product portal tests remain green.
- `npm run build`: TypeScript typecheck and Vite production build passed.

These checks do not prove deployed cookie/Identity/Billing integration or live activation. Release validation must exercise real same-origin login, consent, paid activation and return-to-agent behavior against staging, including cancellation, expiry, session loss, rejected CSRF and duplicate approval retries.


### Provider-wrapper privacy correction

Even sanitized console messages can acquire provider wrappers containing the incoming private authorization path. Therefore deployment must disable provider logs/traces/issue collection on this service. Migration `migrations/subscribe/0002_trace_spans.sql` stores only closed typed events in the existing SESSIONS D1 binding, with seven-day expiry and indexed trace retrieval. Every write performs bounded cleanup of at most 128 expired records; every read filters expiry independently, so expired data is never returned even during cleanup backlog.

The fixed service endpoint is `POST /v1/service/amail/trace-query`, not an ID-bearing URL. It requires `Authorization: Bearer AMAIL_SERVICE_KEY` (dedicated secret, minimum 32 characters, constant-time comparison), JSON content type and the exact body `{trace_id: "32 lowercase nonzero hex characters"}`. Unknown/duplicate fields, URL queries and bodies larger than 256 bytes are rejected. The response is `{schema_version:1,spans:[...]}`, limited to 128 unexpired typed envelopes ordered by timestamp and event ID. This endpoint skips self-persistence and never exposes database expiry columns or request metadata.

Follow-up verification: 14 Subscribe Rust tests passed, including strict trace-query shape and identifier validation. A Python SQLite in-memory probe applied both migrations, verified typed envelope insertion, expiry filtering, exact closed query projection, bounded 128-row cleanup and outcome CHECK rejection. Release must apply migration 0002 and provision the AMAIL_SERVICE_KEY secret before enabling the hosted flow.

### Server-only browser handoff ancestry

The first authenticated authorization GET receives Billing's validated response traceparent restoring the original amail creation trace. Subscribe stores that context against the SHA-256 hash of the opaque authorization handle, never the raw handle. A subsequent authorization GET/approve/cancel reads the unexpired context before creating its server span; stored Billing ancestry takes precedence over browser-generated page roots. The server then generates a fresh dependency child and sends that context to Billing. This joins approval to the original amail creation trace without exposing continuation context in URLs, browser storage or user-controlled metadata.

Continuation state is in `subscribe_authorization_traces` (migration 0002), expires after 30 minutes and uses bounded 128-row cleanup. Only successful authenticated GET responses to the exact Billing authorization lookup route establish or refresh context. Reads and writes are best-effort: missing state or D1 errors fall back to normal browser/new-root tracing without changing authorization behavior. Billing must preserve an incoming trace when its trace ID already matches its stored creation trace; otherwise it restores its original creation ancestor. The initial cross-trace GET is a handoff boundary, while the later approval forms a fully parent-linked chain.

Verification: 15 native Subscribe tests passed, including stored-parent preference, malformed-context rejection, exact lookup route filtering and TTL. A SQLite migration probe verified hash-only persistence, lookup isolation and strict expiry.

## Actual amail v0.2.0 staging acceptance (2026-10-07)

[Mail acceptance 37621170985](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37621170985)
passed with native candidate source `de427af16097eff247ec33b831c829de89b56890`.
The protected synthetic identity completed real login, cancellation, Lite approval,
normal return-link navigation, authoritative CLI receipt and Lite projection.
A preceding legitimate administrator-issued `amail-lite` code was received through
the explicitly authorized owned amail mailbox and redeemed once in
[37619968691](https://github.com/kleedaisuki/moesegfault-amail/actions/runs/37619968691).
An independent fixed read-only issuance/redemption join confirmed exactly one
redemption; the temporary test secret was deleted. The successful later run used
`grant_source=existing`, not a reusable code.

Safe artifact `11482721812` contains 14 validated retained spans connecting
CLI to Mail to Billing and the real Subscribe approval ancestry. It contains no
authorization URL, code, mail content or principal. The same run passed actual
SMTP/archive/search/delete and controlled self-send recovery/delivery acceptance.
Billing and Subscribe remain the staging runtime versions recorded in
`docs/deployment`; no production deployment or Identity-sector change was made.
This proves subscription authorization and entitlement projection, not payment
collection: existing activation grants and usage accrual remain the Billing model.
