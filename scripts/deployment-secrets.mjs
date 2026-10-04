#!/usr/bin/env node
/**
 * Provision staging Worker secrets from ignored repository-local files without disclosure.
 * Usage: node scripts/deployment-secrets.mjs
 * Create the admin key first with `node scripts/admin-key.mjs --init`.
 * Store the configurable administrator email in `.secrets/admin-email` before provisioning.
 */
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) throw new Error('No arguments accepted; secret provisioning is staging-only.');

/** Read a git-ignored file, pipe it into Wrangler, and print only the secret name/status. */
async function put(service, name, file) {
  const ignored = spawnSync('git', ['check-ignore', '--quiet', file], { cwd: root, stdio: 'ignore' });
  if (ignored.status !== 0) throw new Error(`Secret source must be git-ignored: ${file}`);
  const value = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).trim();
  if (!value || value.includes('\n')) throw new Error(`Secret source must contain one nonempty line: ${file}`);
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'secret', 'put', name, '--config', `wrangler.${service}.jsonc`,
  ], { cwd: root, input: value, encoding: 'utf8', timeout: 60_000 });
  // Child output is deliberately not forwarded: transport diagnostics can include sensitive values.
  if (result.error || result.status !== 0) throw new Error(`Could not provision ${service}:${name}; inspect authentication/configuration separately.`);
  process.stdout.write(`Provisioned staging ${service}:${name}.\n`);
}

await put('billing', 'BILLING_ADMIN_KEY', '.secrets/billing-admin-key');
await put('billing', 'ADMIN_EMAIL', '.secrets/admin-email');
await put('subscribe', 'CLIENT_PRIVATE_KEY_JWK', '.secrets/subscribe-staging-private.jwk');
