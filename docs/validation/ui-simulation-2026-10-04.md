# Subscribe UI browser simulation — 2026-10-04

## Scope and expected contract

Executed the built `apps/subscribe/dist` React application in the native Codex
in-app browser against an isolated Node loopback fixture. Expected behavior comes
from the user's three-language/theme/profile/activation/account workflow and
`docs/subscribe-ui.md`, not from fixture implementation claims. No real account,
password, mail, staging tab, or external mutation was used. This is a UI
simulation, **not staging end-to-end acceptance**.

Environment: Windows PowerShell, Node v26.10.0, repository main based on d4bf3ad,
existing production Vite bundle. No Rust compilation or dependency installation.

## Reproduction

Run from repository root:

```powershell
node scripts/tests/browser-simulation-server.mjs
```

The fixture binds only `127.0.0.1:4397`. Before a fresh run remove only its
`.temp/ui-simulation/requests.jsonl` file, because request evidence is append-only.
Using the Browser skill's native browser API in a new isolated tab:

1. Open `http://127.0.0.1:4397/?locale=zh-CN&theme=light&plan=fixture-monthly`.
2. Fill the billing name with `Synthetic UI Customer`, email with
   `fixture@example.invalid`, country with `cn`, and save.
3. Activate `RETRY-A`: first call returns 503. Submit again unchanged: success.
4. Select Japanese, dark, then English. Do not reload the query-controlled locale.
5. Submit `BAD-CODE` (422), then `RETRY-B` (503), then change to `RETRY-C` (503).
6. Set responsive viewport 390 x 844; capture mobile full-page screenshot.
7. Open `/account?embedded=1&locale=ja&theme=dark`; inspect no forms/inputs and
   top-level management/reconnect targets. Reset viewport afterward.
8. Open `/?locale=en&theme=light&scenario=load-failure`; first session call is
   503. Click Try again. Verify saved name and CN remain after application reload.
9. Replace billing email with `not-an-email`; click Save profile. Native browser
   validation must prevent a second profile PUT.

```powershell
node scripts/tests/browser-simulation-evidence.mjs
```

Observed evidence assertion output: PASS for retry idempotency, changed-code
attempt, profile normalization, invalid-email blocking, and mutation CSRF.
Stop the fixture process after testing.

## Observed outcomes

| Scenario | Result |
| --- | --- |
| Chinese profile save | Success notice; PUT contains all optional fields, entered synthetic name/email, and uppercased CN |
| Same-code 503 retry | Both POSTs use the same UUID Idempotency-Key; second succeeds |
| Successful activation | Input cleared, subscription refreshed to Active, valid continuation link displayed |
| Invalid code 422 | Actionable localized error; entered code remains editable |
| Code edited after 503 | RETRY-B and RETRY-C use different UUID keys |
| zh-CN / ja / en | Heading, form labels, status dates, plan names and feedback switch; document lang en observed |
| Light / dark | Upstream theme selection switches; document data-moe-theme dark observed; screenshots inspected |
| Mobile main portal | Actual document client/scroll width 375/375 (scrollbar-adjusted 390 viewport); no horizontal overflow; stacked forms and usable activation button |
| Mobile account embed | client/scroll width 390/390; zero forms/inputs; management and reconnect links target _top |
| Load 503 and retry | Visible error and Try again; retry restores authoritative fixture subscription/profile |
| Invalid email | Native typeMismatch=true, valid=false; no additional PUT |

Screenshots and synthetic JSONL are deliberately local artifacts:

- `.temp/ui-simulation/zh-light-success.jpg`
- `.temp/ui-simulation/ja-dark.jpg`
- `.temp/ui-simulation/en-dark-mobile.jpg`
- `.temp/ui-simulation/account-ja-dark-mobile.jpg`
- `.temp/ui-simulation/en-light-recovered.jpg`
- `.temp/ui-simulation/requests.jsonl`

## Verdict and limits

The exercised UI workflows passed; no production defect was found in this scope.
The first fixture attempt crashed on a missing static resource because the harness
sent headers before reading the file; the harness was corrected and restarted
before claimed checks. An initial guessed Japanese appearance locator failed;
fresh accessibility state showed its actual label was `表示`, after which selection
worked. Neither was a product failure.

This does not validate actual OIDC, mail delivery, Cloudflare bindings, D1
transactions, token validation, production code redemption, or account-origin
iframe policy. Hosted staging must independently prove those boundaries. No
concurrency timing, real 401/session expiry, or screen-reader audit was claimed.
The account embed was opened directly, not inside Identity's actual iframe.

## Dashboard and SSO regression journey — 2026-10-24

The built redesigned UI passed a reproducible Chromium browser journey against
an isolated loopback BFF fixture. This is **frontend simulation, not hosted
Identity, D1, mail or staging acceptance**. The fixture uses the real
`infra/plans.staging.json` catalog (seven plans across Platform, amail and Agents),
but all account/profile/subscription data and activation codes are synthetic.

### Reproduce

Build from the repository root, then provide an installed Playwright module if it
is not resolvable through normal Node package lookup:

```powershell
npm run build
# Optional: set PLAYWRIGHT_MODULE to an absolute installed playwright/index.mjs.
# Optional: set PLAYWRIGHT_CHANNEL to chrome or msedge to select an installed browser.
node scripts/tests/browser-redesign.mjs
```

The runner owns an ephemeral loopback listener and an isolated browser context,
then closes both. It never opens an existing browser profile, reads credentials,
or contacts Identity/mail. `PLAYWRIGHT_MODULE` is a runtime path, not a new
application dependency. Observed environment: Windows, Node 26.10.0, bundled
Chromium 151.0.7922.34. The final execution passed 20 journey assertion groups
with zero page errors, in approximately seven seconds.

| Journey | Observed outcome |
| --- | --- |
| Account/catalog separation | Default `/` shows only the two authoritative account subscriptions and one initially collapsed billing address, with zero catalog cards. Explicit Browse products navigation reaches `/products`, where three product cards contain 1/3/3 plans |
| Empty account | An account with zero subscriptions still displays zero rows and zero product offerings even though the available catalog has seven plans |
| Public product browsing | Authenticated and guest `/products` show no private subscription/address/activation forms and issue no `/api/billing` request; guest browsing does not start SSO |
| Return navigation | Catalog navigation returns to subscription-only `/`; authenticated plan action targets `/?<integration hints>#activate` |
| Agents continuation | Synthetic Agents app/plan/allowed return hints survive account → products → brand → account → products → activation and reload; Return to app stays the session-approved Agents URL; no subscription is fabricated |
| Sensitive-parameter exclusion | Local portal links retain exactly app, plan and return_to; synthetic OAuth code/state/access_token/id_token/refresh_token plus auth_error/csrfToken are not forwarded |
| Important terms | On `/products`, requested amail Plus disclosure opens and retains the complete real catalog overage/settlement terms |
| Billing edit/save | Saved synthetic name, address and contact appear in one account summary; lowercase country becomes CN |
| Cancel and native validation | Cancel discards unsaved edits; invalid email produces native typeMismatch and no additional profile PUT |
| Activation uncertainty | Same-code 503 retry keeps its UUID; edited code gets a new UUID; invalid code remains editable; CSRF accompanies mutations |
| Reload | Two subscriptions, saved address and Return to app link persist |
| Locale/theme/responsive | Chinese, Japanese and English work in dark theme at 390px; additional 320/375/768/1024/1440px layouts and 320px edit form do not overflow horizontally |
| Keyboard disclosure | Enter opens the native plan details without starting activation |
| Account integration view | Embedded viewer has no forms, inputs or catalog; management/switch links target _top; guest embed does not start iframe SSO |
| Load failure | Initial session 503 recovers through the visible retry action |
| Logout | Private account state disappears and automatic SSO does not immediately undo explicit logout |
| Bounded SSO | Fresh guest top-level entry attempts SSO once; simulated denied callback and reload do not repeat it |
| Auth/security failures | CSRF 403 preserves account state; 401 removes subscriptions, billing address and continuation without a redirect loop |
| Expired-session billing draft | A profile-save 401 retains a ten-minute subject-bound invoice draft; same-subject reauthentication restores editing; successful save clears the draft |

The first SSO harness attempt incorrectly expected a new automatic login after
intentional logout in the same tab. The logout suppression marker correctly
prevented that. The fresh-entry scenario now explicitly clears only that
synthetic tab marker, separately from the logout assertion. A keyboard harness
locator initially selected the next closed details element after the first
opened; it now tracks the stable first plan. Neither was a product failure. The later explicit-catalog navigation introduced a real 320px heading overflow: the longer Browse products link competed with the heading in a nonwrapping flex row. The width assertion detected it; production CSS was fixed to wrap the heading/navigation, and the unchanged 320px check then passed.

Synthetic local evidence is under `.temp/ui-redesign/`: `results.json`,
`requests.jsonl`, desktop and three-language mobile PNGs, and the Account embed
PNG. Desktop account, empty-account mobile and Japanese product-catalog mobile screenshots were visually
inspected: subscription status leads, activation is compact, catalog browsing is a separate intent, and the single billing address is not duplicated per subscription.
Failure screenshots/DOM dumps, if present, are diagnostic artifacts from earlier
harness attempts and are not the basis of the final verdict.

This runner does not establish actual cross-service SSO reuse, token expiry,
mail delivery, entitlement enforcement, account-origin framing, or Cloudflare
performance. Those require independent hosted acceptance. The Agents round-trip regression uses a synthetic session-approved return URL; it does not navigate to the real Agents service or prove its forced entitlement refresh. No payment or paid
usage authorization is submitted by this test.
