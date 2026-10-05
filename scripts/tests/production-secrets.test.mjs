/** Cheap production bootstrap contracts; fixtures never touch deployment credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { clientManifest, validateSecret, validateConfig, secretInvocation } from '../deployment-production-secrets.mjs';

test('admin inputs are single-line, typed, and reject unknown secret names', () => {
  assert.equal(validateSecret('BILLING_ADMIN_KEY', 'A'.repeat(43)), 'A'.repeat(43));
  assert.equal(validateSecret('ADMIN_EMAIL', 'operator@example.invalid'), 'operator@example.invalid');
  for (const value of ['', 'short', 'A'.repeat(43) + '\n']) assert.throws(() => validateSecret('BILLING_ADMIN_KEY', value));
  for (const value of ['', 'not-an-email', 'a@example.invalid\nb@example.invalid']) assert.throws(() => validateSecret('ADMIN_EMAIL', value));
  assert.throws(() => validateSecret('UNKNOWN', 'value'));
});

test('production config cannot target staging, another Worker, or implicit environments', () => {
  for (const service of ['billing', 'subscribe']) {
    const config = { name: `moesegfault-${service}`, vars: { ENVIRONMENT: 'production' } };
    assert.doesNotThrow(() => validateConfig(service, config));
    assert.throws(() => validateConfig(service, { ...config, name: `${config.name}-staging` }));
    assert.throws(() => validateConfig(service, { ...config, vars: { ENVIRONMENT: 'staging' } }));
    assert.throws(() => validateConfig(service, { ...config, env: {} }));
  }
  assert.throws(() => validateConfig('other', {}));
});

test('Wrangler transports only stdin, suppresses child output and disk logs', () => {
  const value = 'A'.repeat(43);
  const invocation = secretInvocation('billing', 'BILLING_ADMIN_KEY', value);
  assert.equal(invocation.options.input, value);
  assert.equal(invocation.args.includes(value), false);
  assert.equal(invocation.args.at(-1), 'wrangler.billing.production.jsonc');
  assert.deepEqual(invocation.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(invocation.options.env.WRANGLER_WRITE_LOGS, 'false');
  assert.equal(invocation.options.timeout, 60_000);
  assert.throws(() => secretInvocation('subscribe', 'BILLING_ADMIN_KEY', value));
});

test('public manifest contains exact production registration and no private RSA fields', () => {
  const actual = JSON.parse(readFileSync(new URL('../../infra/subscribe-production-client.json', import.meta.url), 'utf8'));
  assert.equal(actual.client_id, 'subscribe');
  assert.equal(actual.sector_identifier, 'subscribe.moesegfault.dev');
  assert.equal(actual.token_endpoint_auth_method, 'private_key_jwt');
  assert.deepEqual(actual.scopes, ['openid', 'profile']);
  assert.deepEqual(actual.redirect_uris, [{ uri: 'https://subscribe.moesegfault.dev/auth/callback', match_mode: 'exact' }]);
  assert.deepEqual(actual.post_logout_redirect_uris, [{ uri: 'https://subscribe.moesegfault.dev/auth/logout/callback', match_mode: 'exact' }]);
  const key = actual.public_jwks[0];
  assert.deepEqual(Object.keys(key).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
  assert.equal(key.kid, 'subscribe-production-20261005');
  assert.equal(key.alg, 'RS256');
  assert.ok(Buffer.from(key.n, 'base64url').length >= 256);
});

test('manifest derivation strips private RSA parameters and rejects metadata drift', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'subscribe-production-20261005' };
  const publicKey = clientManifest(jwk).public_jwks[0];
  assert.equal(publicKey.n, jwk.n);
  assert.equal(publicKey.d, undefined);
  assert.throws(() => clientManifest({ ...jwk, kid: 'subscribe-staging-20261004' }));
});
