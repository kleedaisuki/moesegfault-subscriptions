# Production administrator email diagnostic — 2026-10-05

## Scope and invariants

Inspect the single already-accepted production issuance whose non-secret intent
begins `9b94cb58`. Do not create a replacement intent, send again, change production
backend code, or disclose the administrator credential, activation capability,
recipient address, mail body, or token. The formal recipient was restored by the
deployment helper's `finally` path and its source file was not changed.

## Established observations

| Observation | Meaning |
| --- | --- |
| Helper `after_utc` is `2026-10-05T05:50:40.472Z` (13:50:40.472 Asia/Singapore) | This timestamp was captured **before** the synchronous temporary-recipient secret update, not after deployment convergence |
| Helper calls issuance immediately after successful `wrangler secret put` | No independent check identifies the serving Worker version or effective recipient |
| API returned `status=sent` | `admin.rs` observed successful binding acceptance and persisted its receipt |
| Owned test mailbox search found no message in the bounded 180-second window | Inbox arrival/indexing is not confirmed; this does not prove bounce or wrong-recipient delivery |
| Helper restored formal recipient after the bounded wait | No test override remains intentionally configured |

The deployed handler uses `send_with_builder(...).await.is_ok()`. worker-rs exposes
`EmailSendResult.message_id()` but this result is discarded; neither the receipt
nor `admin_issuance` stores provider correlation or an effective recipient snapshot.
Thus the current application data cannot distinguish old-secret routing from
delayed delivery. Replaying this intent returns its existing receipt, not a resend.

## Provider contract and discriminating probe

Cloudflare defines Sent as accepted/queued and Delivered as accepted by the
recipient mail server. Its Workers binding returns an opaque message ID, unlike
the send REST response's grouped delivered/queued/bounce lists. There is no reason
to send a second email just to obtain another type of receipt.

Email activity is available through zone-level GraphQL `emailSendingAdaptive`,
requiring Analytics Read permission. The useful bounded query covers
05:50:40–05:53:50 UTC and this service's sender. Retrieve only timestamp, provider
status, event type, message ID, and recipient for **in-memory classification**.
Persist or display only `recipient_class=test|formal|other`, status, timestamp,
and opaque correlation hash; never raw recipient, subject, message preview, body,
SMTP detail containing addresses, or complete provider responses.

| Probe outcome | Interpretation / next action |
| --- | --- |
| `formal` recipient event | Immediate secret-change request may have hit the prior serving version; recover the existing formal-mailbox delivery without issuing again |
| `test` + `delivered` | Provider-to-mail-server handoff succeeded; investigate authorized mailbox arrival/indexing/spam handling |
| `test` + queued/sent without final outcome | Bound a later metadata lookup; retain the same intent and do not resend |
| `test` + `deliveryFailed` | Inspect categorical failure metadata without exposing addresses; reconcile the existing grant before any new delivery action |
| No event or Analytics permission denial | Record the diagnostic limitation, not a delivery failure; use an authorized operator's Activity log metadata view |

`wrangler secret put` creates and deploys a new version immediately. This is not an
observed per-request recipient proof or a documented guarantee that every edge
has converged before the next HTTP request. The old-recipient hypothesis remains
a hypothesis until an event recipient or serving-version observation resolves it.

## Actual provider probe result

The deployment owner successfully performed the single metadata query (no
permission or GraphQL error) for 05:50:40–05:53:50 UTC, exact service `from` filter,
limit 20. It returned **zero events**. No recipient, subject, body, or raw message
ID was emitted. This result does not select either delivery-latency or old-recipient
explanations: provider analytics indexing and exact sender-field normalization
remain unresolved. The worker constructs a named EmailAddress; an exact bare
address filter is not independently established as equivalent to the event's
`from` field. Any follow-up should be explicitly authorized, retain the same short
time bound and safe output policy, and change only the event-selection criterion
to distinguish filter mismatch. Do not widen to mail content or mint another code.

Root authorized exactly one discriminating follow-up: the same window and limit,
replacing the exact `from` filter with `sendingDomain=moesegfault.dev`. Sender and
recipient dimensions were used only transiently for categorical classification.
This query also succeeded without permission/schema errors and returned **zero
events**. No further queries or sends were performed. Provider events therefore
cannot resolve this intent under the approved bounds; mailbox delivery and the
old-recipient hypothesis remain unconfirmed, not disproven.

The acceptance gate should stay explicit: production service availability is
confirmed separately, but this test issuance's mailbox arrival is not confirmed.
Continue with the existing intent only. An authorized operator may inspect its
existing formal inbox/provider Activity log metadata; changing recipient secrets
again or retrying with a new UUID would not repair the missing correlation proof.

## Future operational improvement (not implemented in this probe)

Preserve the provider's opaque message ID in an additive nullable receipt field,
keeping existing response fields and state semantics compatible. Correlation need
not expose recipient addresses or mail content. Acceptance tooling should verify
the intended deployed version before a destructive one-shot send after changing
bindings; avoid adding retries that mint or resend authorization capabilities.

## Sources

- [Workers Email Sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Email activity log status semantics](https://developers.cloudflare.com/email-service/observability/logs/)
- [Email Analytics datasets and zone-level permissions](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
- [Workers secrets and immediate version deployment](https://developers.cloudflare.com/workers/configuration/secrets/)
- Implementation: `crates/billing/src/admin.rs`, worker-rs 0.8.6 `src/bindings/email.rs`.
- Private helper and sanitized receipt: `.temp/production-acceptance/admin-mail-once.mjs`, `.temp/production-acceptance/mail-check-status.log`.
