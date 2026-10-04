# Subscribe and Account frontend integration

## Subscribe handoff

An application links to Subscribe using registered product / plan identifiers and an approved return location. Treat every query parameter as untrusted. Never accept an arbitrary callback URL or copy its hostname into authentication configuration.

Subscribe owns the subscription journey: authenticate through Identity, show the plan and current state, collect or edit a billing profile, redeem an activation code, then display the updated subscription. No card collection or invented payment-provider success state is appropriate in the activation-code release.

Use React with TypeScript, the shared moeSegFault style primitives, English / Japanese / Simplified Chinese translations, and light / dark themes. Keep the actual task prominent: plan, entitlement, activation input, status, and next action. Legal notices may be precise; ordinary product copy should not expose engineering verification rituals.

## Account integration

Account's subscription section is a first-party read surface. Its same-origin backend validates the Account session and requests Billing for that authenticated principal; the browser must not receive an administrator token or a reusable OAuth bearer. Integration should not require changing Identity's authentication service contract.

Do not infer a subscription from profile completeness or a successful redirect. Fetch the authoritative state after activation and after returning to Account. Handle empty, loading, active, expired, and recoverable-error states without implying a purchase occurred.

## Acceptance flow

Use a controlled staging user: register and verify email through Identity, return to Subscribe, complete the profile, activate a legitimately issued code, verify its period / entitlement, and observe the same subscription from Account. Test a replay to ensure it does not grant extra time.
