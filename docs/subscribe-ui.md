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

- `/`: catalog, subscription status, activation code, billing profile, local logout.
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
Atmosphere comes from warm surfaces and a CSS-only membership illustration, not
unhelpful product claims. Narrow screens omit the illustration. Reduced-motion
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
