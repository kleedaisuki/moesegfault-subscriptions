#!/usr/bin/env node
/**
 * Create-only staging OIDC key material and a public deployment manifest; never print private keys.
 * Usage: node scripts/deployment-oidc-client.mjs
 * This does not register the client. Apply a reviewed Identity configuration migration separately.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = '.secrets/subscribe-staging-private.jwk';
const kid = 'subscribe-staging-20261004';
if (process.argv.length !== 2) throw new Error('No arguments accepted: staging only.');
if (spawnSync('git', ['check-ignore', '--quiet', file], { cwd: root }).status !== 0) throw new Error('Private key location must be git-ignored.');
await mkdir(new URL('../.secrets/', import.meta.url), { recursive: true, mode: 0o700 });
let privateJwk;
try {
  privateJwk = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateJwk = { ...key.privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid };
  await writeFile(new URL(`../${file}`, import.meta.url), `${JSON.stringify(privateJwk)}\n`, { flag: 'wx', mode: 0o600 });
}
if (process.platform === 'win32') {
  const user = spawnSync('whoami', [], { encoding: 'utf8' }).stdout.trim();
  const secured = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(F)`], { cwd: root, stdio: 'ignore' });
  if (secured.status !== 0) throw new Error('Unable to restrict private-key file ACL.');
}
const manifest = {
  client_id: 'subscribe-staging', display_name: 'moeSegFault Subscribe',
  client_type: 'confidential', token_endpoint_auth_method: 'private_key_jwt',
  sector_identifier: 'subscribe-staging.moesegfault.dev', subject_salt_revision: 1,
  redirect_uris: [{ uri: 'https://subscribe-staging.moesegfault.dev/auth/callback', match_mode: 'exact' }],
  post_logout_redirect_uris: [{ uri: 'https://subscribe-staging.moesegfault.dev/auth/logout/callback', match_mode: 'exact' }],
  scopes: ['openid', 'profile'],
  public_jwks: [{ kty: 'RSA', n: privateJwk.n, e: privateJwk.e, alg: 'RS256', use: 'sig', kid }],
};
await writeFile(new URL('../infra/subscribe-staging-client.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write('Staging private key retained in ignored local file; public client manifest written to infra.\n');
