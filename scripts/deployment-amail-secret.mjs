#!/usr/bin/env node
/** Provisions the dedicated amail service key into the explicitly selected Billing realm without exposing child output. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] ?? 'staging';
if (process.argv.length > 3 || !['staging', 'production'].includes(target)) throw new Error('Explicit staging or production target required.');
if (target === 'production' && process.env.PRODUCTION_DEPLOY_CONFIRM !== 'production-only') throw new Error('Production confirmation required.');
const suffix = target === 'production' ? '.production' : '';
// Validate both destinations before the first independently committed secret update.
for (const service of ['billing', 'subscribe']) {
  const config = JSON.parse(readFileSync(new URL(`../wrangler.${service}${suffix}.jsonc`, import.meta.url), 'utf8'));
  if (config.name !== `moesegfault-${service}${target === 'staging' ? '-staging' : ''}` || config.vars.ENVIRONMENT !== target) throw new Error('Selected realm configuration required.');
}
let value = process.env.AMAIL_SERVICE_KEY;
if (!value) {
  const file = `.secrets/amail-service.${target}.key`;
  if (spawnSync('git', ['check-ignore', '--quiet', file], { cwd: root, stdio: 'ignore' }).status !== 0) throw new Error('Service credential source must be ignored.');
  value = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').trim();
}
if (value.length < 32 || value.length > 256 || /[\r\n\0]/.test(value)) throw new Error('Invalid service credential shape.');
for (const service of ['billing','subscribe']) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'AMAIL_SERVICE_KEY', '--config', `wrangler.${service}${suffix}.jsonc`], {
    cwd: root, input: value, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error(`Could not provision ${target} ${service} service credential; inspect deployment authentication separately.`);
  process.stdout.write(`Provisioned ${target} ${service} AMAIL_SERVICE_KEY.\n`);
}
