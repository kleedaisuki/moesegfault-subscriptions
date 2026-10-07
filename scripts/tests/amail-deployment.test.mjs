/** Staging service-bridge isolation and non-disclosing provisioning contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Read tracked deployment text without inspecting any private credential. */
function source(path) { return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'); }

test('amail bridge catalog and callback stay staging-only without sector mutation', () => {
  const staging = JSON.parse(source('wrangler.billing.jsonc'));
  const production = JSON.parse(source('wrangler.billing.production.jsonc'));
  assert.equal(staging.vars.SUBSCRIBE_ORIGIN, 'https://subscribe-staging.moesegfault.dev');
  assert.deepEqual(JSON.parse(staging.vars.AMAIL_RETURN_URL_ALLOWLIST), ['https://amail-staging.moesegfault.dev/billing/return']);
  const plans = JSON.parse(staging.vars.PLAN_REGISTRY_JSON).filter(p => p.product_id === 'amail');
  assert.deepEqual(plans.map(p => p.id), ['amail-free', 'amail-lite', 'amail-plus']);
  assert.ok(plans.every(p => p.entitlements.some(e => e.startsWith('amail.plan.'))));
  assert.equal(JSON.parse(production.vars.PLAN_REGISTRY_JSON).some(p => p.product_id === 'amail'), false);
  assert.deepEqual(JSON.parse(staging.vars.BILLING_AUDIENCES), ['subscribe-staging']);
});

test('dedicated service credential provisioning suppresses diagnostics and never selects production', () => {
  const script = source('scripts/deployment-amail-secret.mjs');
  assert.ok(script.includes("input: value"));
  assert.ok(script.includes("WRANGLER_WRITE_LOGS: 'false'"));
  assert.ok(script.includes("config.name !== 'moesegfault-billing-staging'"));
  assert.ok(script.includes("'AMAIL_SERVICE_KEY'"));
  assert.ok(!script.includes('stdio: \'inherit\''));
  assert.ok(!script.includes('console.log(value)'));
  assert.ok(!script.includes('wrangler.billing.production.jsonc'));
  const workflow = source('.github/workflows/ci.yml');
  assert.ok(workflow.includes('AMAIL_SERVICE_KEY: ${{ secrets.AMAIL_SERVICE_KEY }}'));
  assert.ok(workflow.indexOf('node scripts/deployment-amail-secret.mjs') < workflow.indexOf('npm run deploy:staging'));
  assert.ok(!workflow.slice(workflow.indexOf('  production:')).includes('AMAIL_SERVICE_KEY'));
});
