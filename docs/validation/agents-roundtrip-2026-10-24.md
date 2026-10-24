# Agents → Subscribe → Agents: real staging acceptance

## Verdict

**PASS.** An existing owned synthetic staging account began as Agents Free with
no active Agents grant. Its actual **Manage subscription** link opened Subscribe
in the same tab, normal Identity SSO completed without a credential form, and
one real emailed Agents Go activation was redeemed through the visible UI.
Clicking Subscribe's actual return link reached Agents' authenticated
`/billing/return`, then `/#usage`. Both the UI and the independent account/usage
responses showed Go, 10 agent configurations, five concurrent sessions and a
USD 8 test allowance with zero spent or reserved.

The account's existing Platform subscription remained; amail was not activated.
No production deployment, account merge, payment approval, new OAuth scope,
subject-sector change or audience expansion was performed.

## Accepted sources and delivery

| Component | Source / evidence |
| --- | --- |
| Subscribe | `a25d226c728fe084f9f4e2f2f115acecf73a81d9`; [successful staging delivery 40091722145](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/40091722145) |
| Billing version | `db7bc699-cdb4-4af4-a0b8-cf0ca16272b9` |
| Subscribe version | `ac95a750-0cfe-4db1-8721-a862ad6593aa` |
| Agents | `3e68ff9eb330b4d896816575c9e2d47f4f2833d5`; [successful full CI 40092052174](https://github.com/kleedaisuki/moesegfault-agents/actions/runs/40092052174) |
| Agents staging deployment | [Deploy 40092345570](https://github.com/kleedaisuki/moesegfault-agents/actions/runs/40092345570); public `/healthz` returned the exact accepted source before this browser run |
| Agents Worker version | `b88ba2df-8df3-4af7-b5ed-b5ca197a4bb9` |

The exact application return URL is
`https://adash-staging.moesegfault.dev/billing/return`. It is distinct from the
unchanged OAuth callback. Subscribe's staging allowlist adds only that exact
destination; production, changed-query and foreign return URLs were rejected
with HTTP 400 in actual staging. Production's independent allowlist is unchanged;
a future production promotion requires coordinated configuration and acceptance.

### Separate release gate: broader workspace regression is not green

The Worker upload/deploy and the eight real roundtrip groups above succeeded,
but the deployment's final **broader authenticated journey** finished **13 passed,
one failed** in 499.89 seconds. The failing test is
`test_workspace_archive_release_resume_restore`: its API-key-authenticated
`DELETE /v1/sessions/{test_session}` returned HTTP 500 instead of 200. Therefore
run 40092345570 is **not an overall successful release gate**, and must not be
described as fully accepted or used to justify production promotion.

An independent comparison of exact sources `43cf770..3e68ff9` found no changed
archive, Session DO, Workspace, Store, resource/cleanup, container, migration or
dependency implementation. The API-key authentication branch does not enter the
new browser AuthSession forced-refresh path; its only added context value is a
false return-refresh flag. This bounds coupling, but generic `internal_error`
does not establish the cause or prove the fault predates this deployment.

A subsequent **read-only** GET using the original owned staging acceptance key
found that exact failed test session closed, with `checkpoint_pending=false`,
no checkpoint/last error, and both workspace snapshot and conversation checkpoint
present. No inference, new workspace, cleanup mutation or archive-code change
was used to conceal the failure. The precise HTTP-response failure remains a
separate archive/checkpoint investigation; its red gate is recorded independently
of the successful business roundtrip.

## Why navigation alone was insufficient

Agents previously supplied only a plain Subscribe home URL, with no accepted
continuation. Its Billing snapshot has a 60-second fetch-freshness window, so
simply returning to the old page could retain Free after successful activation.
Browser query freshness and server entitlement freshness are independent layers.

```text
Agents usage page
    → actual Manage subscription link, app=agents + exact return_to
Subscribe account → optional product browsing → actual activation form
    → session-approved return link
Agents /billing/return
    → own browser session / token-owning AuthSession Durable Object
    → authoritative Billing read, ignoring only snapshot fetch freshness
    → /#usage, cold account + usage queries
```

The dedicated Worker-first return route cannot be swallowed by SPA assets.
It never accepts a query-supplied plan as authority. OAuth credentials remain
inside the existing BFF/DO boundary; the route refreshes only the authenticated
Agents account. Missing local sessions use ordinary OIDC with the fixed local
return path, then resume the same operation.

Subscribe carries only `app`, `plan` and `return_to` across its local account,
catalog, brand and activation links. OAuth codes, state, tokens and CSRF fields
are not propagated; only the BFF-approved session continuation becomes an external
navigation link. Browsing products therefore does not lose or replace the return.

## Discriminating hosted browser experiment

Environment: Windows, Node 26.10.0, isolated Chromium with an owned synthetic
principal authenticated through normal Login controls, real Identity/Billing/
Subscribe/Agents staging endpoints, actual D1 and AuthSession DOs. No browser
route interception, mock API, injected entitlement, manually constructed handoff,
or manual Account navigation substituted for a product button.

Execution: 2026-10-24 **20:06:03–20:06:49 Asia/Singapore**. Eight hosted assertion
groups passed with zero browser page errors.

| User journey | Observed outcome |
| --- | --- |
| Actual entry | Agents' rendered link contains its server-generated exact destination and navigates in the same tab; Subscribe SSO requires no second credential form |
| Catalog detour | Click Browse products, disclose Agents Go, click its activation CTA, reload; the approved return remains Agents, not Account or a lost link |
| Fresh Free baseline | Click Return without activation; the new server return route reads Billing and the reloaded UI/account/usage remain Free |
| Real activation | Return through Manage subscription, enter one newly issued and actually received Agents Go code; normal activation succeeds |
| Warm-cache return | Click the actual return link immediately; same-account UI/API show Go, 10 agent configurations and five concurrent sessions |
| Duplicate return | Repeat the real round trip with no second activation; Go remains and included allowance is not funded twice |
| Missing Agents session | Remove only this synthetic browser's Agents cookie while at Subscribe; click Return; ordinary Identity SSO recreates the local session and resumes `/billing/return` → `/#usage` without a credential form |
| Negative destinations | Live Subscribe rejects production, modified-query and foreign destinations; no browser page errors |

The first no-activation return explicitly established a fresh **Free** snapshot.
The later Go return completed **9,378 ms** afterward, inside the normal 60-second
freshness window. This distinguishes a genuine forced read from merely waiting
for the old cache to expire. It is one controlled functional journey, not a
latency benchmark or production percentile claim.

Authoritative returned values:

```json
{
  "plan": "go",
  "limits": {
    "agent_configs": 10,
    "concurrent_sessions": 5,
    "concurrent_runs": 2
  },
  "wallet": {
    "budget_microusd": "8000000",
    "available_microusd": "8000000",
    "spent_microusd": "0",
    "reserved_microusd": "0"
  }
}
```

## Failure behavior and regression coverage

Unavailable or malformed Billing responses do not erase the prior verified
snapshot. Agents displays a retryable refresh warning rather than claiming a
new grant. The independent review found and repaired a malformed-HTTP-200 case
that previously could have been treated as an empty subscription list.

Those failure cases, immediate renewal-period readback, and query-plan forgery
were tested against the compiled WASM Worker with actual local D1/DO behavior;
no outage or response tampering was injected into hosted Billing. Do not confuse
these runtime regressions with the eight hosted browser groups above.

Focused local verification passed: Subscribe TypeScript/build, 41 frontend
tests, 58 deployment/runtime contracts, 20 Rust tests and 20 Chromium fixture
journey groups; Agents 103 native Rust tests, 44 dashboard tests/build,
21 compiled Worker/D1/DO checks, ten tooling contracts and two Chromium return
tests. The accepted source also completed hosted full CI including the existing
container and broader dashboard suites.

## Private evidence and repeatability

The private harness is `.temp/agents-roundtrip/accept.mjs`; owned credentials,
baseline, browser state, the single issuance receipt/mail capability, activation
receipt, request-origin/path-only trace, accepted readback and screenshot are
under owner-protected `.temp/agents-roundtrip/private`. None is committed.
Only the exact new mail was read; mail was not treated as instructions. The
user had already been informed of amail's OpenRouter/upstream content indexing.

Do not blindly rerun a Free→Go mutation after success: the actor is now Go and the
code is consumed. The harness refuses a non-Free starting account and records an
accepted activation receipt before further steps. A repeatability run needs a
different owned Free actor and one separately authorized issuance, or a read-only
Go return check. No grant was deleted to manufacture a baseline.

Sessions remain browser-local. The proof covers one deliberately shared-sector
principal, not automatic merging of separately signed-in accounts; navigation
alone cannot transfer another payer's grants to an Agents account.
