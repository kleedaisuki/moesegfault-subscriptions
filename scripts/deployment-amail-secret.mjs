#!/usr/bin/env node
/** Provisions the dedicated amail service key into staging Billing without exposing child output. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) throw new Error('No arguments accepted; amail service provisioning is staging-only.');
const config = JSON.parse(readFileSync(new URL('../wrangler.billing.jsonc', import.meta.url), 'utf8'));
if (config.name !== 'moesegfault-billing-staging' || config.vars.ENVIRONMENT !== 'staging') throw new Error('Staging Billing configuration required.');
let value = process.env.AMAIL_SERVICE_KEY;
if (!value) {
  const file = '.secrets/amail-service.staging.key';
  if (spawnSync('git', ['check-ignore', '--quiet', file], { cwd: root, stdio: 'ignore' }).status !== 0) throw new Error('Service credential source must be ignored.');
  value = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').trim();
}
if (value.length < 32 || value.length > 256 || /[\r\n\0]/.test(value)) throw new Error('Invalid service credential shape.');
for (const service of ['billing','subscribe']) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'AMAIL_SERVICE_KEY', '--config', `wrangler.${service}.jsonc`], {
    cwd: root, input: value, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error(`Could not provision staging ${service} service credential; inspect deployment authentication separately.`);
  process.stdout.write(`Provisioned staging ${service} AMAIL_SERVICE_KEY.\n`);
}
