# Safe staging authentication diagnostics

## Persistent logging boundary

Both Wrangler configs retain custom Workers Logs but explicitly set
`observability.logs.invocation_logs=false` and `observability.redact_query_string=true`.
Cloudflare's invocation messages include
the method and full request URL; an OAuth callback carries a one-use authorization
code and state in that URL. Automatic invocation logging is therefore inappropriate
for this authentication-facing service. No tracing/export destination is enabled.
The query-redaction setting also protects enriched custom-log metadata and future
traces from callback query capabilities. These settings do not disable application
diagnostics or promise redaction of
exceptions; application logs/errors must independently avoid secrets.

[Cloudflare Workers Logs: invocation and custom logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
documents this supported switch. It takes effect on the next deployment; it does
not remove previously stored logs or alter the Identity service's logging policy.
[Script settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/)
also documents `redact_query_string`; both fields were patched in place in staging
and read back before the diagnostic acceptance retry, without rebuilding artifacts.

## Realtime acceptance probe

```powershell
# Run the repository-owned filter, never raw Wrangler tail with a transcript.
node scripts/deployment-auth-tail.mjs subscribe --once
# Optional sanitized output only:
node scripts/deployment-auth-tail.mjs subscribe --once |
  Tee-Object -FilePath .temp/acceptance/identity-diagnostic.log
```

The wrapper spawns pinned Wrangler privately using its server-side console-message
search and `pretty` format, whose pinned implementation emits console messages as
`  (warn) <message>`. It consumes but never forwards request lines, exceptions,
stderr, full event JSON, or unknown custom logs. A complete anchored allowlist
accepts only Billing's single constant diagnostic:
`identity_verification_rejected stage=<known enum> category=<known enum>`.
Diagnostic output contains only the selected fixed service name and those fixed
categories. Connection feedback is a fixed local string, never copied from the
provider message. `--once` stops after the first accepted category; otherwise the
session has a ten-minute ceiling. SIGINT/SIGTERM close its tail child.
The wrapper explicitly sets `WRANGLER_WRITE_LOGS=false`: Wrangler otherwise writes
its full pretty output to a hidden global debug log even when stdout is piped
through a filter. The pinned Wrangler `shouldLogToDisk` implementation supports
this flag. `WRANGLER_LOG_SANITIZE=true` is retained as additional defense.

Only the Subscribe Worker needs a tail for callback token verification, because it
links Billing's verifier into its BFF binary. A separate Billing tail is available
for direct resource-server failures. Do not enable broad raw capture to look for
a missing diagnostic: verify deployed revision, staging ENVIRONMENT, and the
one-use new browser authorization flow first. Unknown enum strings are intentionally
dropped until a reviewed classifier/allowlist update is made.

Tests exercise the actual filter against valid messages, URL/code fixtures, unknown
categories, appended claims, multiline strings and errors. The filter does not
decode or log JWTs and never inspects account/session rows to diagnose rejection.

## Actual first filtered result

A fresh real browser callback produced only
`identity_verification_rejected stage=jwks category=identity_verification_unavailable`.
This directed the verifier owner to outbound metadata fetch construction rather
than weakening signature/nonce/audience checks or reading user tokens. A real
Miniflare/workerd probe reproduced rejection of `RequestRedirect::Error` when
constructing the Worker request. The repair uses `Manual` and still requires
exact HTTP 200, so redirects remain rejected; the runtime regression is in
`scripts/auth-runtime.test.mjs`. See [authentication boundary](../authentication.md).

The first tail revealed Wrangler's separate global debug-file behavior. The exact
task-owned debug file was removed without displaying its contents; the already
applied platform query redaction prevented a callback code query in that file.
All subsequent tail sessions explicitly disable disk logging before connection.
The persisted acceptance tail contains only fixed connection feedback and the
fixed classifier, not request metadata or authentication capabilities.
