# Staging toolchain advisory remediation — 2026-10-07

## Trigger and bounded decision

The first amail Billing integration check, GitHub Actions run `37614622042`, passed
Rust/WASM and domain/deployment contracts but failed the existing `npm audit
--audit-level=high` gate. The newly indexed advisory
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
identifies sharp versions below 0.35.5 as vulnerable through their bundled librsvg.
The upstream advisory names sharp 0.35.5 (bundled librsvg 2.63.2) as the patched
release. Registry metadata confirms Node >=20.9.0, compatible with pinned CI Node24.

The affected development dependency chain was Wrangler 4.147.0 → Miniflare
5.20261001.0-alpha → sharp 0.35.4. The fix pins the transitive sharp dependency to
0.35.5 through npm overrides and regenerates the lockfile. Wrangler, Miniflare,
Worker APIs, production configuration, and all security gates stay unchanged.
Do not use `npm audit fix --force`: its proposed Wrangler 4.15.2 downgrade would
remove supported deployment/runtime APIs and introduce an unrelated major toolchain
regression. The override can be removed when a reviewed Wrangler/Miniflare release
already resolves to a patched sharp version.

## Acceptance

Run `npm ls sharp`, `npm audit --audit-level=high`, and `npm run test:deployment`
(including actual workerd authentication/runtime tests), then frontend typecheck,
unit tests and production asset build. Hosted CI remains authoritative for Linux
platform packaging. No vulnerability suppressions or disabled audit gates are used.

Local acceptance after the targeted override: `npm audit --audit-level=high` reported
zero vulnerabilities; `npm ls sharp` resolved exactly 0.35.5 under unchanged Wrangler
4.147.0 and Miniflare 5.20261001.0-alpha. All 39 deployment/runtime tests passed,
including a new native sharp trusted 2×2 SVG-to-PNG smoke test, all 24 frontend tests,
TypeScript, and the frontend production build. Linux CI is the remaining platform
acceptance; no deployment is implied by these local results.
