---
name: moesegfault-billing
description: Integrate moeSegFault Billing accounts, subscription activation, Subscribe checkout, and authorized local administrator issuance. Use for billing consumers and first-party subscription views; not for implementing authentication or payment providers.
---

# moeSegFault Billing

Choose the trust boundary first, then read only the relevant reference.

| Task | Reference |
| --- | --- |
| Server-side account/profile/subscription consumer | [Billing consumers](references/consumers.md) |
| Subscribe checkout or Account subscription section | [Frontend integration](references/frontend.md) |
| Local administrator code issuance and recovery | [Administrator operations](references/admin.md) |

## Invariants

- Identity authenticates people; Billing validates the bearer credential and owns billing data.
- Map a person by fixed `(issuer, sub)`, never by mutable email or username.
- The browser calls its same-origin backend. Do not expose bearer tokens, OAuth client secrets, or administrator credentials to React or browser storage.
- An activation code is a bearer capability. Never put it in a URL, log, analytics event, screenshot, public fixture, or support transcript.
- Plan registration is deployment configuration. Existing issued codes preserve their granted plan snapshot when the catalog changes.
- Reuse the original idempotency key after an uncertain response. A new key means a genuinely new action, not an HTTP retry.
- Keep staging and production issuer, client, database, origin, key, and recipient configuration separate.

Read the repository's `openapi` contract and actual route implementation before changing payloads. Do not interpret these integration notes as a claim that a deployment has passed its acceptance gate.
