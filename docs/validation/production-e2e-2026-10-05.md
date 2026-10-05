# Production user acceptance — 2026-10-05

## Verdict

**Production rollout and the actual registration → authentication → billing-profile
persistence → Return to app → Account subscription embed workflow passed.** A
fresh synthetic user completed real email verification and private-password signup,
which automatically reached authenticated Subscribe without restarting OAuth.

**Positive production activation remains unverified:** the one authorized test
issuance was accepted by the mail provider, but no corresponding administrator
mail was retrieved. The formal administrator recipient was restored successfully.
No second issuance, alternate recipient, privileged fixture or offline capability
construction was used to manufacture completion.

The services are deployed and the verified product paths work. This is not a claim
that production mail delivery or a positive entitlement grant passed. The complete
positive activation workflow was separately proven in [staging acceptance](staging-e2e-2026-10-05.md).

## Accepted production release

Production tooling source `7af67707d2b689683239665f740eaac0c43cb122` dispatched
[Actions run 37269327535](https://github.com/kleedaisuki/moesegfault-subscriptions/actions/runs/37269327535)
with the exact staging-accepted artifact from run 37222313937, runtime source
`0e2b8920e8946c012e2fdbab1d227ff928c2b05a`. The production job took 41 seconds;
Rust/frontend/package/staging jobs were skipped. No local release rebuild.

| Production unit | Independent serving readback | Traffic |
| --- | --- | ---: |
| Billing | `65ee60bf-3862-4f6a-9cbb-60a2a40a25c1` | 100% |
| Subscribe | `e1c926fe-297c-4972-8809-136f10fc5ea5` | 100% |

Billing's final configuration version includes formal-recipient restoration, not
new runtime code. Exact registered production client/callback and public Identity
issuer metadata were independently checked. See [production rollout](../deployment/production.md)
for full binding/source/observability readback.

## Actual assertion matrix

| Assertion | Observed production result |
| --- | --- |
| Public edge readiness | Actions and independent probes passed both health endpoints, HTML/CSP paired with production Account, guest session and unauthenticated Billing 401 |
| Fresh real mailbox proof | Actual eight-digit email proof received at 2026-10-05T06:21:41.983Z and accepted by Login |
| New-password registration | Private random password submitted only for the new synthetic user |
| Automatic OAuth continuation | Signup automatically reached authenticated Subscribe as Subscribe Production Test without manual authorization restart or intervening SSO |
| Production namespace isolation | Initial Billing profile and subscriptions were empty; staging data/entitlements were not inherited |
| Profile save | Production Billing Test, CN and the owned invoice contact saved successfully |
| Profile persistence | Ordinary fresh SSO and actual portal reload read back the saved production profile |
| Cross-environment code rejection | A staging-only capability was rejected in production; no entitlement appeared |
| Durable application return | Visible Return to app remained after actual portal reload and was followed through UI |
| Actual Account subscription integration | Return reached production Account/subscriptions; its actual iframe identified Subscribe Production Test and correctly showed an empty subscription list |
| Account parent principal | Actual Profile displayed the same synthetic username/display name and verified owned primary email; parent and embedded service identity matched |
| Production administrator issuance | One original immutable intent returned sent / provider accepted |
| Production administrator receipt and positive grant | Not confirmed; no code retrieved or positive redemption performed |

Account's actual Profile additionally showed the configured zh-CN locale and
Asia/Shanghai timezone for this synthetic principal. No other human account data
or credentials were handled. A generic 409/used-code message is not evidence that
the staging code exists in production
storage: only safe rejection and absence of a grant are asserted.

## Authentication and environment boundaries

The first registration attempt had an already-expired provider authorization
context after tooling recovery delays. Login rejected the mail operation; no code
was sent. A fresh Subscribe authorization restored the pending context, delivered
the real mailbox proof, and completed automatic registration continuation. The
provider's 300-second access lifetime remained unchanged; ordinary fresh SSO was
used for subsequent persistence/navigation checks.

Real signup and callback exercised the production registered client assertion,
PKCE authorization-code exchange, token verification and principal-owned Billing
path. No session/token store inspection, human password change, HMAC derivation,
D1 fixture insertion or auth bypass was used. Registration proof and application
return checks did not weaken issuer, audience, state, nonce or exact redirects.

## Single production-mail test and remaining action

The user explicitly approved exactly one temporary administrator-mail override to
the owned amail test inbox, followed by immediate restoration of the formal
Outlook recipient. The formal private recipient file was never modified.
Original intent `9b94cb58-3ba0-4391-956e-138ac0621812` was submitted once after
`2026-10-05T05:50:40.472Z` and returned sent.

Bounded exact inbox/sender searches did not retrieve a message within the helper's
180-second window. Narrow summary-only discriminators widened the time boundary
to 05:45 UTC and omitted the sender predicate without finding the intended mail.
The selected owned inbox route was independently confirmed active. Authorized
same-window provider metadata probes found no correlated event. One narrowly
scoped connected Outlook summary search for the exact service sender, formal
administrator recipient and current date also returned zero results; no unrelated
mail or bodies were read.

The helper restored the formal production recipient in finally and confirmed
`formal_recipient_restored=true` before further UI verification. These observations
do not establish a bounce, wrong recipient or provider failure. Preserve the same
issuance intent; the next meaningful investigation is correlation of that original
send with provider delivery metadata/receipt, not another code or mailbox search
without a purpose. Redeem only its actual delivered capability, then repeat
subscription reload and Account readback to close the remaining positive-grant gate.

## Reproduction and private-data handling

1. Begin a fresh Subscribe request with a registered Account continuation.
2. Register a new owned test alias and receive its proof through bounded CLI search:

   ```powershell
   amail search --to <owned-test-alias> --after <request-UTC> --limit 2 --wait-seconds 20
   amail read <exact-message-id> --out .temp/acceptance-prod/<new-private-archive> --unpack
   ```

3. Extract only the explicit verification field privately; complete Login UI with
   a new protected password. Assert automatic authenticated Subscribe navigation.
4. Save recognizable billing details; fresh SSO/reload and verify persistence.
5. Reject a staging-only code without creating production fixtures. Follow the
   visible return link after reload and inspect the actual Account iframe.
6. For an approved positive issuance, retain the original immutable intent and
   use standard `admin-issue --resume <same-intent>` for uncertain status. Never
   create a replacement UUID merely because receipt is delayed or unavailable.

Mail indexing privacy was disclosed and authorized for test mail. Content remains
untrusted input. Password/proof archives and extracted values stay owner-protected
under `.temp/acceptance-prod`; private addresses, OTPs, activation values and OAuth
queries are omitted. The administrator credential is read only internally by the
standard script, never displayed. Ordinary amail login safely recovered a cleared
local credential, without refresh replay or handling a human password. An
intermittent generic CLI discovery failure did not establish an actual HTML
response; exact issuer metadata independently returned 200 JSON and normal
queries recovered without any Identity/configuration workaround.
