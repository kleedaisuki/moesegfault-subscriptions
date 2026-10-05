/** Verify isolated production state and immutable successful-staging promotion without network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { acceptedArtifact } from '../deployment-accepted-artifact.mjs';
import { validateCatalog } from '../deployment-plans.mjs';

test('production bindings cannot point at staging data, issuer, audience, service, or frame origin', async () => {
  for (const service of ['billing', 'subscribe']) {
    const production = JSON.parse(await readFile(new URL(`../../wrangler.${service}.production.jsonc`, import.meta.url), 'utf8'));
    const staging = JSON.parse(await readFile(new URL(`../../wrangler.${service}.jsonc`, import.meta.url), 'utf8'));
    assert.equal(production.name, `moesegfault-${service}`);
    assert.equal(production.vars.ENVIRONMENT, 'production');
    assert.equal(production.d1_databases[0].database_name, `moesegfault-${service}-production`);
    assert.notEqual(production.d1_databases[0].database_id, staging.d1_databases[0].database_id);
    assert.deepEqual(production.routes, [{ pattern: `${service}.moesegfault.dev`, custom_domain: true }]);
    assert.equal(production.observability.redact_query_string, true);
    assert.equal(production.observability.logs.invocation_logs, false);
    for (const secret of ['BILLING_ADMIN_KEY', 'ADMIN_EMAIL', 'CLIENT_PRIVATE_KEY_JWK']) assert.equal(production.vars[secret], undefined);
    if (service === 'billing') {
      assert.equal(production.vars.IDENTITY_ISSUER, 'https://identity.moesegfault.dev');
      assert.deepEqual(JSON.parse(production.vars.BILLING_AUDIENCES), ['subscribe']);
      const catalog = JSON.parse(await readFile(new URL('../../infra/plans.production.json', import.meta.url), 'utf8'));
      assert.deepEqual(validateCatalog(catalog), JSON.parse(production.vars.PLAN_REGISTRY_JSON));
    } else {
      assert.equal(production.vars.ISSUER, 'https://identity.moesegfault.dev');
      assert.equal(production.vars.CLIENT_ID, 'subscribe');
      assert.equal(production.vars.ACCOUNT_ORIGIN, 'https://account.moesegfault.dev');
      assert.deepEqual(production.services, [{ binding: 'BILLING', service: 'moesegfault-billing' }]);
    }
  }
});

test('production client public registration matches its isolated BFF configuration', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../infra/subscribe-production-client.json', import.meta.url), 'utf8'));
  assert.equal(manifest.client_id, 'subscribe');
  assert.equal(manifest.sector_identifier, 'subscribe.moesegfault.dev');
  assert.deepEqual(manifest.scopes, ['openid', 'profile']);
  assert.equal(manifest.public_jwks[0].kid, 'subscribe-production-20261005');
  assert.deepEqual(manifest.redirect_uris, [{ uri: 'https://subscribe.moesegfault.dev/auth/callback', match_mode: 'exact' }]);
  for (const key of manifest.public_jwks) for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(key[field], undefined);
});

test('promotion rejects unrelated, failed, expired, and never-deployed staging artifacts', () => {
  const source = 'a'.repeat(40);
  const repository = 'kleedaisuki/moesegfault-subscriptions';
  const run = { repository: { full_name: repository }, path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_sha: source };
  const jobs = [{ name: 'Deploy staging', conclusion: 'success' }];
  const artifacts = [{ name: `staging-${source}`, expired: false }];
  assert.deepEqual(acceptedArtifact(run, jobs, artifacts, repository), { source, name: `staging-${source}` });
  assert.throws(() => acceptedArtifact({ ...run, conclusion: 'failure' }, jobs, artifacts, repository));
  assert.throws(() => acceptedArtifact(run, [], artifacts, repository));
  assert.throws(() => acceptedArtifact(run, jobs, [{ ...artifacts[0], expired: true }], repository));
  assert.throws(() => acceptedArtifact(run, jobs, artifacts, 'unrelated/repository'));
});
