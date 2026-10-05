# Subscribe and Account frontend integration

## Subscribe handoff

An application links to Subscribe using registered product / plan identifiers and an approved return location. Treat every query parameter as untrusted. Never accept an arbitrary callback URL or copy its hostname into authentication configuration.

Subscribe owns the subscription journey: authenticate through Identity, show the plan and current state, collect or edit a billing profile, redeem an activation code, then display the updated subscription. No card collection or invented payment-provider success state is appropriate in the activation-code release.

The preauthentication registration transaction lasts 30 minutes. Authenticated sessions are separately bounded by Identity's 300-second access-token lifetime; no refresh token is requested. On expiry, clear protected content and offer explicit SSO sign-in while retaining only validated application continuation. Do not interpret the registration window as permission to extend authenticated access.

Use React with TypeScript, the shared moeSegFault style primitives, English / Japanese / Simplified Chinese translations, and light / dark themes. Keep the actual task prominent: plan, entitlement, activation input, status, and next action. Legal notices may be precise; ordinary product copy should not expose engineering verification rituals.

## Account integration

Account's subscription section is a first-party read surface. The current integration links to or displays the Subscribe-owned viewer, which authenticates through the same registered gateway; Account's cookie is not a Billing credential. The browser must not receive an administrator token or a reusable OAuth bearer.

A future independent Account or application BFF must follow the [consumer subject-sector registration contract](consumers.md#pairwise-subjects-and-application-onboarding) before querying the same subscriptions. The same human's separately authenticated session does not guarantee the same pairwise `sub`. Use deliberately shared per-environment billing sectors and exact audience allowlists, not email or internal-claim joins. A deployed sector change requires migration; an unsupported delegation model requires an approved Identity contract decision, not an authentication-service change made as frontend integration.

Do not infer a subscription from profile completeness or a successful redirect. Fetch the authoritative state after activation and after returning to Account. Handle empty, loading, active, expired, and recoverable-error states without implying a purchase occurred.

## Acceptance flow

Use a controlled staging user: register and verify email through Identity, return to Subscribe, complete the profile, activate a legitimately issued code, verify its period / entitlement, and observe the same subscription from Account. Test a replay to ensure it does not grant extra time.

See the [staging acceptance report](../../../docs/validation/staging-e2e-2026-10-05.md) for the integrated staging result. Production uses its own issuer, `subscribe` client, `subscribe.moesegfault.dev` subject sector, callbacks, keys, and databases and requires a separate acceptance run. Do not reuse staging sessions or recipient overrides in production.
