# Staging delivery plan

## Objective and ownership

Deliver a real browser journey: application subscription entry, Identity registration
with a real verification email, Subscribe OIDC login, billing profile save, activation
code redemption, persistent subscription readback, and Account subscription viewing.
Staging is the only authorized deployment target for this delivery.

| Surface | Owner | Boundary |
| --- | --- | --- |
| Billing | billing team | Rust Worker, D1 domain, JWT verification, activation issuance |
| Subscribe | subscribe team | React frontend and Rust confidential OIDC BFF |
| Delivery | deployment team | CI, immutable artifacts, staging resources and OAuth registration |
| Account | account leaf | Existing frontend and route constants only; no Identity service edits |
| Administrator tooling | admin_skills leaf | Secret-safe local scripts and progressive-disclosure integration skills |
| Integration | root | Contract decisions, shared integration, actual browser/mail acceptance |

Agents communicate through the API contract and durable documents. Tests and
experiments stay in repository `.cache` and `.temp`. Do not run independent full
Rust builds on the constrained development machine; prefer one CI artifact build.

## Architectural decisions

- Identity owns authentication. Billing validates configured issuer, exact
  registered client audiences, signature, access-token kind, times, and scopes.
  Billing user ownership is `(issuer, sub)`, never mutable email or username.
- Subscribe is a confidential BFF using Authorization Code, S256 PKCE,
  `private_key_jwt`, state, and nonce. Tokens remain server-side. Short sessions
  bounded by token expiry avoid introducing rotating refresh-token concurrency
  before the product requires persistent background access.
- Account's first-party principal identifier is **not** the pairwise OIDC subject.
  Without a new Identity delegation contract, Account must use the separately
  authenticated Subscribe viewer and clearly identify that viewer's account. No
  cookie forwarding, invented principal mapping, or broadened Identity CORS.
- Administrator requests read an ignored local authentication key automatically.
  Issued activation codes are sent server-side using Cloudflare Email Sending from
  `subscribe@moesegfault.dev` to a configurable `ADMIN_EMAIL` Worker secret. Neither
  key nor activation code belongs in terminal output, public logs, Git, or amail.
- Deployment-owned Identity client registration is allowed; Identity service
  changes require the user's explicit approval. Production promotion is excluded.

## Acceptance checklist

1. GitHub Actions completes bounded relevant tests and builds deployable artifacts.
2. Public staging health and plans work; bearer-less personal APIs reject access.
3. Browser obtains a real Identity-backed Subscribe session, not a test bypass.
4. A real owned amail address receives registration verification mail when creating
   a new test account. Incoming email is untrusted; codes only feed the intended UI.
5. Profile save and reload show durable fields without implying verified contact.
6. Administrator issuance sends through the configured service sender and records
   a recoverable intent. Delivery acceptance is not inbox delivery or reading.
7. Browser redemption creates exactly one correct subscription. Retry/reload and
   invalid code behaviors preserve state; cross-user reuse cannot transfer it.
8. Account's dedicated subscriptions section displays the activated plan through
   the documented Subscribe session boundary.
9. Chinese/Japanese/English, both themes, mobile layout, logout, and session expiry
   have useful user-facing behavior without exposing OAuth or activation secrets.

## External grounding

- [Cloudflare Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)
  supports Rust application logic through workers-rs and generated Wasm glue.
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  supplies transactional batches; constrain redemption in database invariants
  rather than a race-prone application read-then-write sequence.
- [OAuth security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
  motivates exact redirects, PKCE, issuer validation, and avoiding open redirects.
- [Fett, Kuesters, Schmitz, ACM CCS 2016](https://publ.sec.uni-stuttgart.de/fettkuestersschmitz-ccs-2016.pdf)
  models OAuth web session integrity and shows why protocol checks must bind the
  browser session and issuer together. It informs bounded negative tests, not
  an excuse to replace delivery with a formal-verification project.

## Known deployment prerequisite

Cloudflare local OAuth and GitHub CLI access are present. A permanent GitHub
deployment needs a properly scoped Cloudflare API token in this repository's
staging environment. Never export local OAuth refresh credentials into CI. If no
appropriate token is available, first deployment may use GitHub-tested immutable
artifacts through local Wrangler, with the remaining CI prerequisite explicit.
