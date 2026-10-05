#!/usr/bin/env node
/** Create production-only credentials once and provision them without exposing material. */
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, constants, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, secretDirectory, prepareSecrets, protect } from './admin-key.mjs';

export const directory = join(secretDirectory, 'production');
const manifestPath = join(root, 'infra/subscribe-production-client.json');
const kid = 'subscribe-production-20261005';

/** Reject links and nonregular files before reading any local private input. */
function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_private_file');
  protect(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readFileSync(fd, 'utf8').trim(); } finally { closeSync(fd); }
}

/** Prepare owner-only, Git-ignored production storage; never follow a directory link. */
function prepare() {
  prepareSecrets();
  mkdirSync(directory, { mode: 0o700 });
}

/** Reuse an existing directory safely without replacing any credential. */
function storage() {
  try { prepare(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_private_directory');
  protect(directory, true);
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '.secrets/production/admin-email'], { cwd: root, stdio: 'ignore' });
  if (ignored.status !== 0) throw new Error('private_storage_not_ignored');
}

/** Enforce fixed production credentials and reject private-key metadata drift. */
export function validateSecret(name, value) {
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) throw new Error('invalid_secret');
  if (name === 'BILLING_ADMIN_KEY') {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value) || Buffer.from(value, 'base64url').length !== 32) throw new Error('invalid_admin_key');
  } else if (name === 'ADMIN_EMAIL') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) throw new Error('invalid_admin_email');
  } else if (name === 'CLIENT_PRIVATE_KEY_JWK') {
    const jwk = JSON.parse(value);
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || jwk.kid !== kid || jwk.alg !== 'RS256' || jwk.use !== 'sig') throw new Error('invalid_private_key');
  } else { throw new Error('unknown_secret'); }
  return value;
}

/** Public registration metadata is derived solely from the stored private key. */
export function clientManifest(privateJwk) {
  validateSecret('CLIENT_PRIVATE_KEY_JWK', JSON.stringify(privateJwk));
  const publicKey = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({ format: 'jwk' });
  return {
    client_id: 'subscribe', display_name: 'moeSegFault Subscribe', client_type: 'confidential',
    token_endpoint_auth_method: 'private_key_jwt', sector_identifier: 'subscribe.moesegfault.dev', subject_salt_revision: 1,
    redirect_uris: [{ uri: 'https://subscribe.moesegfault.dev/auth/callback', match_mode: 'exact' }],
    post_logout_redirect_uris: [{ uri: 'https://subscribe.moesegfault.dev/auth/logout/callback', match_mode: 'exact' }],
    scopes: ['openid', 'profile'], public_jwks: [{ ...publicKey, alg: 'RS256', use: 'sig', kid }],
  };
}

/** Create a credential exclusively; existing bytes are validated, never regenerated. */
function createOnce(file, name, generate) {
  const path = join(directory, file);
  try {
    lstatSync(path);
    validateSecret(name, privateFile(path));
    return 'existing';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeFileSync(path, generate(), { flag: 'wx', mode: 0o600 });
    protect(path);
    validateSecret(name, privateFile(path));
    return 'created';
  }
}

/** Generate independent production keys and a public, reproducible registration manifest. */
export function initialize() {
  storage();
  const statuses = [
    ['BILLING_ADMIN_KEY', createOnce('billing-admin-key', 'BILLING_ADMIN_KEY', () => randomBytes(32).toString('base64url'))],
    ['CLIENT_PRIVATE_KEY_JWK', createOnce('subscribe-private.jwk', 'CLIENT_PRIVATE_KEY_JWK', () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return JSON.stringify({ ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid });
    })],
  ];
  const manifest = clientManifest(JSON.parse(privateFile(join(directory, 'subscribe-private.jwk'))));
  // Refuse a stale or conflicting public registration instead of silently changing Identity.
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('manifest_conflict');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  return statuses;
}

/** Guard against staging or implicit environments before performing remote writes. */
export function validateConfig(service, config) {
  if (!['billing', 'subscribe'].includes(service) || config.name !== `moesegfault-${service}` || config.vars?.ENVIRONMENT !== 'production' || config.env !== undefined) throw new Error('invalid_production_config');
}

/** Fixed secret-to-service mapping prevents sending a credential to the wrong Worker. */
export function secretInvocation(service, name, value) {
  const names = { billing: ['BILLING_ADMIN_KEY', 'ADMIN_EMAIL'], subscribe: ['CLIENT_PRIVATE_KEY_JWK'] };
  if (!names[service]?.includes(name)) throw new Error('invalid_secret_target');
  validateSecret(name, value);
  return {
    args: ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', name, '--config', `wrangler.${service}.production.jsonc`],
    options: { cwd: root, input: value, stdio: ['pipe', 'ignore', 'ignore'], timeout: 60_000, env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' } },
  };
}

/** Preflight every local input before piping any secret to pinned, repository-local Wrangler. */
export function provision(run = spawnSync) {
  storage();
  const inputs = [['billing', 'BILLING_ADMIN_KEY', 'billing-admin-key'], ['billing', 'ADMIN_EMAIL', 'admin-email'], ['subscribe', 'CLIENT_PRIVATE_KEY_JWK', 'subscribe-private.jwk']];
  for (const service of ['billing', 'subscribe']) validateConfig(service, JSON.parse(readFileSync(join(root, `wrangler.${service}.production.jsonc`), 'utf8')));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/wrangler/package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/u.test(pkg.devDependencies.wrangler) || installed.version !== pkg.devDependencies.wrangler) throw new Error('wrangler_version_mismatch');
  const values = inputs.map(([service, name, file]) => [service, name, validateSecret(name, privateFile(join(directory, file)))]);
  for (const [service, name, value] of values) {
    const invocation = secretInvocation(service, name, value);
    const result = run(process.execPath, invocation.args, invocation.options);
    if (result.error || result.status !== 0) throw new Error('provisioning_failed');
    console.log(`${service}:${name}: provisioned`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv.slice(2).join(' ');
    if (mode === '--init') {
      for (const [name, status] of initialize()) console.log(`${name}: ${status}`);
      console.log('Public manifest: infra/subscribe-production-client.json');
    } else if (mode === '--provision') { provision(); }
    else { throw new Error('invalid_arguments'); }
  } catch {
    console.error('Production secret setup: failed. Usage: node scripts/deployment-production-secrets.mjs --init|--provision. Check private files, permissions, and production configs separately.');
    process.exitCode = 1;
  }
}
