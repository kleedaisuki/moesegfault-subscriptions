#!/usr/bin/env node
/**
 * Deploy an already-verified artifact in dependency order, then run bounded smoke checks.
 * Production requires an explicit target and deployment confirmation; staging remains the default.
 * Usage: npm run deploy:staging; PRODUCTION_DEPLOY_CONFIRM=production-only npm run deploy:production
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] ?? 'staging';
if (process.argv.length > 3 || !['staging', 'production'].includes(target)) throw new Error('Target must be staging or production.');
if (target === 'production' && process.env.PRODUCTION_DEPLOY_CONFIRM !== 'production-only') throw new Error('Production requires explicit deployment confirmation.');
const suffix = target === 'production' ? '.production' : '';
for (const path of ['crates/billing/build/worker/shim.mjs', 'crates/subscribe/build/worker/shim.mjs', 'apps/subscribe/dist/index.html']) {
  if (!existsSync(new URL(`../${path}`, import.meta.url))) throw new Error(`Missing verified artifact: ${path}`);
}
const source = readFileSync(new URL('../.temp/release/source-revision.txt', import.meta.url), 'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Verified artifact source revision is required.');
for (const service of ['billing', 'subscribe']) {
  const config = JSON.parse(readFileSync(new URL(`../wrangler.${service}${suffix}.jsonc`, import.meta.url), 'utf8'));
  const name = `moesegfault-${service}${target === 'staging' ? '-staging' : ''}`;
  if (config.name !== name || config.vars.ENVIRONMENT !== target || config.d1_databases[0].database_name !== `moesegfault-${service}-${target}`) throw new Error('Deployment configuration does not match the explicit environment.');
}

/** Execute pinned Wrangler via Node directly; no shell interpolation or local recompilation. */
function wrangler(...args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    cwd: root, stdio: 'inherit', timeout: 120_000, env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error(`Wrangler ${args[0]} failed; later services were not released.`);
}

for (const service of ['billing', 'subscribe']) {
  if (target === 'staging' && service === 'billing') {
    // Names-only readback makes failed migration recovery visible before any new schema writes.
    wrangler('d1', 'execute', 'moesegfault-billing-staging', '--remote', '--config', 'wrangler.billing.jsonc',
      '--command', "SELECT name FROM d1_migrations ORDER BY id; SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'amail_%' ORDER BY name;", '--json');
  }
  wrangler('d1', 'migrations', 'apply', `moesegfault-${service}-${target}`, '--remote', '--config', `wrangler.${service}${suffix}.jsonc`);
  wrangler('deploy', '--config', `wrangler.${service}${suffix}.jsonc`, '--tag', source.slice(0, 12), '--message', `Verified source ${source}`);
}
process.env.DEPLOYMENT_SMOKE_TARGET = target;
await import('./deployment-smoke.mjs');
