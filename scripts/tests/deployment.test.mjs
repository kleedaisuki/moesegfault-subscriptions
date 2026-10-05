/** Deployment contracts: staging isolation, API routing, and credential-free artifact inputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCatalog } from '../deployment-plans.mjs';

/** Read this repository's JSON Wrangler configuration. */
async function config(service) {
  return JSON.parse(await readFile(new URL(`../../wrangler.${service}.jsonc`, import.meta.url), 'utf8'));
}

test('staging database and domains cannot point at production', async () => {
  for (const service of ['billing', 'subscribe']) {
    const settings = await config(service);
    assert.equal(settings.name, `moesegfault-${service}-staging`);
    assert.equal(settings.workers_dev, false);
    assert.equal(settings.preview_urls, false);
    assert.deepEqual(settings.routes, [{ pattern: `${service}-staging.moesegfault.dev`, custom_domain: true }]);
    assert.equal(settings.d1_databases[0].database_name, `moesegfault-${service}-staging`);
    assert.equal(settings.env, undefined, 'no implicit production configuration exists');
    assert.equal(settings.observability.logs.enabled, true);
    assert.equal(settings.observability.logs.invocation_logs, false, 'raw request URLs must not enter persisted invocation logs');
    assert.equal(settings.observability.redact_query_string, true, 'custom log metadata must not retain callback query capabilities');
  }
  assert.notEqual((await config('billing')).d1_databases[0].database_id, (await config('subscribe')).d1_databases[0].database_id);
});

test('static assets never swallow BFF APIs or OAuth callbacks', async () => {
  const settings = await config('subscribe');
  assert.equal(settings.assets.binding, 'ASSETS');
  assert.equal(settings.assets.run_worker_first, true, 'Rust owns all security headers and account reconnect semantics');
  assert.deepEqual(settings.services, [{ binding: 'BILLING', service: 'moesegfault-billing-staging' }]);
  assert.equal(settings.vars.ISSUER, 'https://identity-staging.moesegfault.dev');
  assert.equal(settings.vars.CLIENT_ID, 'subscribe-staging');
  assert.equal(settings.vars.ACCOUNT_ORIGIN, 'https://account-staging.moesegfault.dev');
});

test('billing accepts only registered staging audience and valid deployment-owned plan', async () => {
  const settings = await config('billing');
  assert.equal(settings.d1_databases[0].binding, 'BILLING_DB');
  assert.deepEqual(JSON.parse(settings.vars.BILLING_AUDIENCES), ['subscribe-staging']);
  const plans = JSON.parse(settings.vars.PLAN_REGISTRY_JSON);
  const catalog = JSON.parse(await readFile(new URL('../../infra/plans.staging.json', import.meta.url), 'utf8'));
  validateCatalog(catalog);
  assert.deepEqual(plans, catalog, 'human-editable catalog must be synchronized before release');
  assert.ok(plans.length > 0);
  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
  for (const plan of plans) {
    assert.ok(Number.isSafeInteger(plan.duration_days) && plan.duration_days > 0);
    for (const language of ['zh-CN', 'en', 'ja']) assert.ok(plan.name[language] && plan.description[language]);
  }
  assert.deepEqual(settings.send_email, [{ name: 'EMAIL', allowed_sender_addresses: ['subscribe@moesegfault.dev'] }]);
  for (const secret of ['BILLING_ADMIN_KEY', 'ADMIN_EMAIL']) assert.equal(settings.vars[secret], undefined);
});

test('catalog rejects duplicate IDs, missing localization, excessive duration, and unsafe entitlements', async () => {
  const plans = JSON.parse(await readFile(new URL('../../infra/plans.staging.json', import.meta.url), 'utf8'));
  assert.throws(() => validateCatalog([plans[0], plans[0]]), /duplicate/);
  assert.throws(() => validateCatalog([{ ...plans[0], duration_days: 3651 }]), /duration/);
  assert.throws(() => validateCatalog([{ ...plans[0], name: { en: 'English only' } }]), /localization/);
  assert.throws(() => validateCatalog([{ ...plans[0], entitlements: ['https://attacker.invalid'] }]), /entitlement/);
});

test('client registration contains only public exact staging metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../infra/subscribe-staging-client.json', import.meta.url), 'utf8'));
  assert.equal(manifest.client_id, 'subscribe-staging');
  assert.equal(manifest.token_endpoint_auth_method, 'private_key_jwt');
  assert.deepEqual(manifest.scopes, ['openid', 'profile']);
  for (const key of manifest.public_jwks) for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(key[field], undefined);
  assert.deepEqual(manifest.redirect_uris, [{ uri: 'https://subscribe-staging.moesegfault.dev/auth/callback', match_mode: 'exact' }]);
});

test('workflow builds once and production promotion requires an explicit manual main-only target', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /needs: \[rust, frontend\]/);
  assert.match(workflow, /environment: cloudflare-staging/);
  assert.match(workflow, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs.delivery == 'staging-only'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /environment: cloudflare-production/);
  assert.match(workflow, /inputs.delivery == 'production-only' && github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /run-id: \$\{\{ inputs.artifact_run_id \}\}/);
  assert.match(workflow, /PRODUCTION_DEPLOY_CONFIRM: production-only/);
  assert.doesNotMatch(workflow, /tar .*\.secrets/);
  for (const action of workflow.matchAll(/uses: (\S+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
