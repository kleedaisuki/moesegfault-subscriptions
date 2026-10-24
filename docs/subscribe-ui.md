# Subscribe UI integration

## Scope and trust boundaries

`apps/subscribe` is a React 19 + TypeScript frontend delivered as the Rust
Subscribe Worker's static assets. It calls only the same-origin BFF. OAuth tokens,
client secrets, activation administration keys, and Identity cookies never enter
the browser application. Login navigation delegates to `/auth/login`; mutations
use the session response's `csrfToken` through `x-csrf-token`.

The external app hints `app`, `plan`, and `return_to` are forwarded to the BFF.
Only `returnTo` from the BFF session response can become a continuation link; the
frontend additionally rejects non-HTTPS schemes. The query's requested plan is
visual context, not activation authority: the code itself selects the grant.

Activation retries retain the same randomly generated `Idempotency-Key` for the
same code after a network/server failure. Editing the code or a definite client
failure starts a fresh attempt. A successful mutation refreshes subscriptions;
refresh failure does not retroactively mark a successfully activated plan failed.

## UI surfaces

- `/`: only the account’s actual subscriptions, activation code, one billing address, and local logout.
- `/products`: explicit product discovery with grouped active plans; no subscription list, activation form, or billing-address panel. Navigation returns to `/`; authenticated plan actions lead to /#activate.
- `/account?embedded=1&locale=ja&theme=dark`: read-only subscription list with an
  explicit **subscription service account** identity and top-level management link.
  This identity is the BFF OIDC session; it is not assumed equal to Identity's
  account page principal, because pairwise subjects cannot be compared that way.
- Embedded login preserves local `/account`, locale, theme, and embedded context.
  Links escaping the iframe use `_top`; no nested login ceremony is attempted.

All billing profile fields are optional in this phase. Blank inputs are sent as
empty strings; nullable existing fields are normalized to empty strings. Email
and country fields use native browser validation when non-empty. Billing contact
information is not inferred from undocumented Identity email claims.

## Platform styling and usability

The UI self-hosts the upstream public v0.1.2 CSS distribution, with license and
provenance in `apps/subscribe/public/style`. Application CSS consumes semantic
`--moe-*` tokens rather than cloning a theme palette. Version pinning prevents a
moving CDN release from changing checkout presentation. The three base CSS files
require no editor, Markdown, KaTeX, or font downloads.

Chinese (`zh-CN`), Japanese (`ja`), and English (`en`) message catalogs have
compile-time key completeness. Locale resolution accepts browser regional tags;
the embedded account query takes precedence over browser preference. Light, dark,
and system modes use the upstream `data-moe-theme` contract. Preference storage
failures do not block any workflow.

Forms use persistent labels, native validity checks, disabled controls while
submitting, visible keyboard focus, and `role=alert`/`role=status` feedback.
Visual hierarchy comes from warm surfaces, grouped products, and compact account actions, not
marketing illustration or unhelpful product claims. Reduced-motion
preferences suppress motion.

## Verification and references

Run from the repository root:

```sh
npm run typecheck --workspace=@moesegfault/subscribe
npm run test --workspace=@moesegfault/subscribe
npm run build --workspace=@moesegfault/subscribe
```

Focused tests cover same-origin request credentials, CSRF, idempotency headers,
structured problem codes, active-plan versus redeemed-code conflicts,
continuation safety, account embed login context, locale completeness, blocked
preference storage, timestamp formatting, and resolution of every product CSS
token against the pinned platform styles.
Browser staging validation must additionally exercise authenticated activation,
profile persistence, locale/theme selection, logout, and account embed rendering.

Implementation references:
- [React controlled inputs](https://react.dev/reference/react-dom/components/input)
  informs initialized, stable string form state.
- [W3C form notifications](https://www.w3.org/WAI/tutorials/forms/notifications/)
  informs concise actionable status and error output.
- [moesegfault-style](https://github.com/kleedaisuki/moesegfault-style) public
  integration guide defines themes, CSS entrypoints, and self-hosting conventions.

No new academic mechanism is required for this bounded portal: the BFF, native
forms, and semantic design tokens deliberately avoid introducing experimental
client-side credential handling or speculative accessibility machinery.

Local verification on 2026-10-04: TypeScript typecheck and production Vite build
passed; all 13 focused Vitest tests passed with a single worker. The production
JavaScript bundle is approximately 214 kB (68 kB gzip), and product CSS is 9.4 kB
(2.6 kB gzip), plus the three pinned platform CSS assets. No local browser fixture
was presented as staging acceptance; the deployment's actual browser validation
remains the integration gate.

## Durable application return navigation

The actual fresh-user staging flow completed signup, activation and profile save,
but reloading the portal hid the application return link because its visibility
depended on the form's transient activation-success state. The link is navigation,
not a claim of payment or entitlement: it now remains visible whenever the server
session supplies an accepted continuation, independent of local success state.
The requesting application must still check Billing itself. The existing 401
boundary removes the session and continuation; the embedded viewer is unchanged.

Two server-rendered frontend regression cases cover fresh/reloaded form rendering
without a success message and removal of the link after session clearing. The
focused suite passed twenty tests, TypeScript passed, and the production build
completed in approximately 100 ms. No backend, authentication, scope or provider
lifetime changed.

## Account dashboard and product hierarchy (2026-10-24)

The domain cardinality is reflected directly in layout, not instructional copy:

- One account owns one billing address/contact profile. It is a summary with an
  explicit Add/Edit action, never duplicated per product or subscription.
- The account's subscriptions are the primary content. Each row presents product,
  plan, expiry, and status. Internal subject/product/plan identifiers are not
  ordinary customer-facing labels; the embedded Account identity remains explicit.
- The separate `/products` catalog groups active plans under products. All tier names and durations
  remain visible; native `details` exposes the deployment-owned complete plan
  description and activation link. Descriptions retain pricing and settlement
  distinctions, without duplicating them across the default view.
- Activation is a compact action alongside subscriptions, not a numbered stage in
  a fictitious linear onboarding process. Catalog selection is context only;
  codes remain authoritative. The accepted continuation remains durable navigation.
- Default-account DOM order is subscriptions, activation, billing address. CSS grid
  places account actions alongside subscriptions on desktop; mobile uses the same
  DOM order. Product discovery is a separate navigation destination, not a panel
  beside account-owned subscriptions. A public catalog entry does not trigger automatic SSO.

Known product names (Platform, amail, Agents) are display-only mappings. Grouping
always uses stable `product_id`, never translated text; future identifiers receive
readable fallback names. Adding deployment-owned localized product metadata remains
an additive future contract improvement, not a prerequisite or a schema migration.

### Session entry and form recovery

Top-level initial guest loads make one automatic `/auth/login` navigation, allowing
Identity's existing SSO cookie to resume authentication even from plain service
links without query hints. An opaque tab-local sessionStorage marker bounds the
attempt. Auth callback errors, blocked storage, embedded Account views, and explicit
logout suppress automatic navigation; manual login is always available. A successful
initial authenticated load clears the marker. The initial-entry effect does not run
again when a later mutation gets 401, so expiry cannot navigate away mid-edit.
Hosted amail consent uses the same bounded entry behavior but still requires explicit
human approval; sign-in never approves consent. Switching account explicitly requests
`prompt=select_account` rather than accidentally reusing the existing BFF session.

A billing profile save rejected with 401 preserves only that invoice draft in
sessionStorage for ten minutes, bound to the authenticated session's opaque subject.
The next same-subject authenticated load consumes the draft and opens it for review;
wrong-subject, expired, invalid or corrupted drafts are discarded. Save/cancel clears
any draft. This limited browser-local PII retention is deliberate recovery behavior;
activation codes, passwords, OTPs and OAuth credentials are never persisted. Normal
editing does not write billing details to browser storage. A refreshed profile updates
the address summary unless the user is actively editing.

### Performance and verification

Billing starts immediately after the session resolves, independently of catalog
latency. This removes an avoidable catalog-to-billing waterfall without issuing an
unauthenticated billing request or moving tokens into the browser. Subscription plan
lookups use a per-render map, and catalog grouping is linear in the plan count.

Focused verification: TypeScript and production build passed, 36 Vitest cases passed
(including ten new hierarchy/SSO/draft cases). Grouping is checked under reordered
catalog inputs; browser validation covers responsive layout, editing, activation,
account embeds, and bounded login. Build output at this milestone: JavaScript
227.20 kB / 72.50 kB gzip, application CSS 10.63 kB / 2.77 kB gzip. This includes
existing hosted consent code; no new runtime dependency, image or webfont was added.

Design rationale and external references:

- [W3C grouping controls](https://www.w3.org/WAI/tutorials/forms/grouping/): visual
  relationships must also be represented by semantic form grouping and labels.
- [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/):
  less-frequent form editing and long terms should not drown out the dominant task.
- [Pirolli and Card, CHI 1995](https://chi1995.acm.org/proceedings/papers/ppp_bdy.htm):
  information-foraging models frame interface structure as a cost/value trade-off.
  Here the practical hypothesis is that grouping tiers by product reduces scanning
  cost; no unmeasured user-study or conversion improvement is claimed.

### Product discovery is not account ownership

The account dashboard never derives subscription rows from the catalog and never
shows unrelated, unenabled products as default content. Only Billing's actual
subscriptions array creates those rows. Expired subscriptions and subscriptions
whose plans are no longer active remain visible; plan availability controls discovery,
not account history. The catalog is still fetched as metadata for authentic subscription
names, but only the explicit /products surface renders product cards. It does not
fetch the private billing aggregate and is browsable without automatic sign-in.

The account's Browse products link opens /products; the catalog's Your subscriptions
link returns to /. Discovery uses native plan detail controls, preserves complete
terms and prices, and links authenticated activation actions to /#activate.

The focused suite now has 39 cases. Added regressions prove that all seven catalog
plans produce zero subscription rows and zero product offerings on an empty account;
that real expired/retired history remains visible without unowned products; and that
catalog actions navigate to the separate account activation surface. Production build
passed (227.87 kB JavaScript / 72.69 kB gzip; 10.49 kB CSS / 2.74 kB gzip).
