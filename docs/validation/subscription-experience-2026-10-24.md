# Subscription experience: hosted staging acceptance — 2026-10-24

## Verdict and release

**PASS:** the real Agents dashboard opened its existing plain Subscribe link in a
new tab; Subscribe automatically completed Identity SSO without another credential
login. The same synthetic account retained its Platform subscription, received a
second Agents subscription through an emailed activation code, and was recognized
as Go by Agents itself. Account's actual iframe displayed both subscriptions.

The release is staging only. No production Worker, registration, customer account,
payment approval, spending authorization, or deployed OAuth scope was changed.

| Artifact | Accepted value |
| --- | --- |
| Source | `2a3e45d91ee515fc52f16abb1300d94d78966fc1` |
| Hosted build/package/deploy | [Actions 40087894663](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/40087894663), successful in 100 seconds |
| Billing version | `2a556ae8-3101-4b94-9795-5b8b3bdb736b` |
| Subscribe version | `fc8e7df0-4cb1-410e-9d86-d398f7c44cbc` |
| Portal | https://subscribe-staging.moesegfault.dev |

The hosted pipeline built both WASM Workers and frontend once, verified the
immutable package, applied the existing migrations, deployed dependency-first,
read back capture settings, and passed smoke. A separate local post-deploy smoke
also passed. The earlier candidate run 40087781311 was intentionally cancelled
before deployment when the explicit-login compatibility issue below was found.

## Product and service ownership

The existing database cardinality was already appropriate; no schema migration
was required. The UI now makes these relationships visible:

```text
Identity principal --(fixed issuer, sector subject)--> Billing account
                                                       |-- one billing address
                                                       `-- subscriptions by product
Product -----------------------------------------------|-- multiple catalog plans
```

Subscribe owns OIDC transactions, its host-only session, and browser management.
Billing owns account/profile, grant periods, and entitlements. Agents consumes
Billing grants using its deliberately shared subject sector and exact registered
audience. amail retains its distinct owner-to-payer consent bridge; neither email
matching nor an automatic SSO completion approves that binding or a budget.

Upstream main was fast-forwarded from b7f6deb to c3dd832 before packaging: staging
already had Agents Go/Plus/Pro and exact consumer audiences. Deploying the stale
local catalog would have removed those integrations. All seven current plans and
all existing audience registrations were preserved.

## Real browser assertions

Environment: Windows, Node 26.10.0, isolated Playwright Chromium 151 context,
English browser locale, hosted staging services and real D1/service bindings.
Only an existing owned synthetic staging principal was used. Browser runtime and
private artifacts remained under repository-local `.temp/ux-acceptance`.

| Journey | Observed result |
| --- | --- |
| Cross-service SSO | Clear only Subscribe cookies, enter the actual Agents dashboard through ordinary Identity SSO, click its real Manage subscription link; the new Subscribe tab authenticates automatically, with no navigation to Login and no credential form |
| Hierarchy | Three product groups, seven plans, two independent subscription rows after activation, exactly one initially collapsed billing address |
| D1 profile write | Edit address through UI; profile PUT returns HTTP 200 and the exact replacement account/address; reload retains it |
| Real mailed grant | Standard administrator issuance sends one synthetic Agents Go code; amail retrieves the exact new message after issuance time; UI redemption succeeds |
| Product independence | Agents Go is added to the same Billing account without replacing or extending the existing Platform subscription; reload retains both |
| Consumer authorization | Agents `/v1/account` independently returns `plan: go` after the grant; this proves the shared-sector consumer relationship rather than trusting a portal success message |
| Existing Account reconnect | With a valid Subscribe session, the established `/auth/login?path=/account&return_to=...` still redirects to Identity, not an old local principal; `/account?reconnect=1` explicitly requests account selection |
| Continuation boundary | An unregistered return destination gets HTTP 400; the accepted Return to app action enters Account's actual subscriptions section |
| Real iframe | Account's environment-paired iframe displays both subscriptions; no forms or inputs; management escapes through `_top` |
| Visual/responsive | Hosted Chinese dark view fits a 390px viewport without horizontal overflow; English light desktop and mobile screenshots captured and visually inspected |
| Logout | Explicit local logout removes private state; reload remains a guest instead of immediately undoing the action with automatic SSO |

The complete final hosted runner passed nine grouped assertions with zero page
errors. The first runner had already redeemed the code and verified both grants,
but an English-only iframe link locator timed out because Account supplied a
different locale. The locator now selects the stable management action. The final
rerun detects the existing Agents grant instead of issuing/redeeming a replacement
code; no duplicate issuance was used to conceal that harness error.

## Measured response times

The same workstation made seven sequential HTTPS requests per route before and
after deployment. Responses were fully consumed; `/api/billing` used the same
synthetic principal. These are client-observed staging timings, not Worker CPU
time, a controlled load test, or a production percentile guarantee. Before/after
network conditions were not randomized; use the result as a useful directional
probe alongside the structural request-count reduction.

| Route | Before median | After median |
| --- | ---: | ---: |
| Guest `/api/session` | 453 ms | 255 ms |
| Public `/api/catalog` | 992 ms | 444 ms |
| Authenticated `/api/billing` | 1,562 ms | 938 ms |

Raw samples in milliseconds:

```text
session before: 1504,463,1109,453,452,435,432
session after:  257,236,232,255,283,276,232
catalog before: 1059,982,992,990,1014,995,986
catalog after:  447,436,422,431,452,444,1079
billing before: 2102,1556,1577,1663,1540,1562,1544
billing after:  916,916,951,938,970,1214,929
```

Mechanisms: returning-user account reads no longer write; profile replacement
uses `UPDATE ... RETURNING`; Billing trace insert/cleanup shares one D1 batch;
Subscribe response/dependency telemetry uses `wait_until`; validated issuer
discovery is cached for five minutes; frontend billing starts as soon as session
resolves rather than waiting on catalog. Billing-side D1 transport counts including
trace persistence change from 5 to 3 for reads and 6 to 3 for profile saves.

## Compatibility and verification

A proposed BFF local-session shortcut was removed before acceptance: deployed
Account reconnect clients do not send a new prompt parameter. Explicit login must
revalidate against Identity so switching Identity accounts cannot silently retain
the previous Subscribe payer. Ordinary already-authenticated portal loads do not
start another login, so the shortcut was unnecessary for the dominant workload.

The five-minute bearer-token boundary remains enforced. No unreviewed
`offline_access` permission or race-prone refresh implementation was added.
Top-level initial guest entry attempts SSO once; callback failure, explicit logout,
blocked storage, and embedded views suppress automatic navigation. A later save
401 retains only a ten-minute same-subject billing draft for explicit reentry.
Actual timed five-minute expiry/draft restoration was not repeated in hosted
staging; it is covered by the reproducible browser fixture, not claimed here.

Local/hosted verification passed: TypeScript, 36 frontend tests, 36 Rust tests,
57 deployment/runtime contracts, 22 SQLite account/grant tests, three administrator
migration checks, production frontend build, WASM builds, formatting/diff checks,
and dependency audit with zero reported vulnerabilities. The independent browser
fixture passed 15 journey groups, including expiry, uncertain activation retries,
403/401 distinction, three languages, keyboard disclosure, and six viewport widths.
See the [fixture report](ui-simulation-2026-10-04.md#dashboard-and-sso-regression-journey--2026-10-24).

Private mail archives, test capabilities, synthetic credentials, session state,
and account identifiers are not committed. Hosted screenshot account/address
regions are masked. Mail subjects/body excerpts undergo amail's disclosed
OpenRouter/upstream indexing; mail was treated only as untrusted task data.

## Follow-up: owned subscriptions, explicit discovery, and human handoff

The user correctly identified that showing all product offerings on the same
"Your subscriptions" page still blurred ownership, despite distinct card groups.
The default `/` now contains only actual Billing subscription records, activation
and the single account address. `/products` is an explicitly requested public
catalog; it neither fetches private Billing data nor automatically signs in guests.
Actual expired/retired subscriptions remain history, not invented catalog entries.

Accepted follow-up source: `fb209e8`, [successful staging run 40090027327](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/40090027327).
Billing version: `aee11b99-bb03-4689-8ab9-d6e091d4464d`; Subscribe version:
`7b622c7c-7288-46c5-b7a0-c7c40eaa59ea`. No production deployment.

The updated fixture passes 19 browser journey groups and 39 frontend tests,
including seven catalog plans with zero owned subscriptions producing zero
subscription rows, and two owned subscriptions producing exactly two rows with
no catalog cards. Narrow heading navigation now wraps at 320px instead of
overflowing. Existing activation, address, expiry recovery and embed checks pass.

Hosted readback separately verified that a guest `/products` displays three
products/seven plans, zero subscription rows, zero private forms, no Billing
request and no auth redirect. For handoff, the existing synthetic staging account
was logged in through normal Identity controls in a **headed, persistent Microsoft
Edge window**, not a browser that closes after testing. Its actual account page
read back two subscription rows and zero catalog cards. The visible native Edge
window title was verified and Windows foreground activation succeeded. The
window was left open on the Chinese staging account dashboard; it is independent
of the app's embedded browser and does not share that browser's session.

The account has Platform and Agents Go test subscriptions, not amail. Reusable
staging-only login credentials are provided in an owner-local ignored secret
file, not in Git or a URL. Browser runtime/profile files remain under repository
`.temp/staging-review`. No verification mail or new grants were needed for this
follow-up. Authentication lifetime remains unchanged; browser visibility does
not imply permanent login or a background refresh workaround.
