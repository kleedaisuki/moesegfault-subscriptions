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
