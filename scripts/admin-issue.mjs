/** Request one email-only activation-code issuance with a persistent retry intent. */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretDirectory, adminKeyPath, prepareSecrets, protect } from './admin-key.mjs';

const origins = new Set(['https://billing-staging.moesegfault.dev', 'https://billing.moesegfault.dev']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Validate and freeze the persisted request; recovery cannot select another environment. */
export function validateIntent(intent) {
  if (!uuid.test(intent?.id ?? '') || !origins.has(intent.origin) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(intent.body?.plan_id ?? '')) throw new Error('invalid_intent');
  Object.freeze(intent.body);
  return Object.freeze(intent);
}

/** Resolve credentials from the immutable request origin, never a separate CLI selector. */
export function keyPathForIntent(intent) {
  const validated = validateIntent(intent);
  return adminKeyPath(validated.origin === 'https://billing.moesegfault.dev' ? 'production' : 'staging');
}

/** Parse a narrow CLI surface. Recovery never permits replacement request parameters. */
export function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--plan', '--environment', '--resume'].includes(key) || !args[i + 1] || values[key]) throw new Error('invalid_arguments');
    values[key] = args[i + 1];
  }
  if (values['--resume']) {
    if (!uuid.test(values['--resume']) || Object.keys(values).length !== 1) throw new Error('invalid_resume');
    return { resume: values['--resume'] };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(values['--plan'] ?? '')) throw new Error('invalid_plan');
  const environment = values['--environment'] ?? 'staging';
  if (!['staging', 'production'].includes(environment)) throw new Error('invalid_environment');
  return { plan: values['--plan'], origin: environment === 'production' ? 'https://billing.moesegfault.dev' : 'https://billing-staging.moesegfault.dev' };
}

/** Keep the complete original intent for unknown HTTP outcomes; never store credentials. */
export function intentFor(input) {
  prepareSecrets();
  const directory = join(secretDirectory, 'issuance');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  protect(directory, true);
  if (input.resume) {
    const path = join(directory, `${input.resume}.json`);
    protect(path);
    const intent = JSON.parse(readFileSync(path, 'utf8'));
    if (intent.id !== input.resume) throw new Error('invalid_intent');
    return validateIntent(intent);
  }
  const intent = validateIntent({ id: randomUUID(), origin: input.origin, body: { plan_id: input.plan } });
  const path = join(directory, `${intent.id}.json`);
  writeFileSync(path, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  protect(path);
  return intent;
}

/** No redirects, response bodies, tokens, mail addresses, or activation codes reach logs. */
export async function issue(intent, key, transport = fetch) {
  validateIntent(intent);
  const response = await transport(`${intent.origin}/v1/admin/activation-codes`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': intent.id },
    body: JSON.stringify(intent.body),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const result = await response.json();
  if (!['sent', 'pending', 'failed', 'unknown'].includes(result.status)) throw new Error('invalid_receipt');
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let intent;
  try {
    intent = intentFor(options(process.argv.slice(2)));
    console.log(`Issuance intent: ${intent.id}`);
    const keyPath = keyPathForIntent(intent);
    protect(keyPath);
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new Error('invalid_local_key');
    const status = await issue(intent, key);
    const messages = { sent: 'Email accepted by the mail provider. Check the administrator mailbox.', pending: 'Delivery is pending. Resume this same intent to check progress.', failed: 'Delivery failed. Resume this same intent; do not create another code.', unknown: 'Delivery outcome needs operator reconciliation. Do not request a new code.' };
    console.log(messages[status]);
    if (status !== 'sent') process.exitCode = 2;
  } catch {
    console.error(intent ? `Request not confirmed. Retry: node scripts/admin-issue.mjs --resume ${intent.id}` : 'Usage: node scripts/admin-issue.mjs --plan PLAN [--environment staging|production], or --resume UUID. Initialize and provision the local key first.');
    process.exitCode = 1;
  }
}
