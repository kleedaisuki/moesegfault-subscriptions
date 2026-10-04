#!/usr/bin/env node
/**
 * Deploy already-built staging artifacts in dependency order, then run bounded smoke checks.
 * No production selector exists; resource UUIDs and hostnames are pinned in reviewed configs.
 * Usage: npm run deploy:staging
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2) throw new Error('No arguments accepted: staging is the only deployment target.');
for (const path of ['crates/billing/build/worker/shim.mjs', 'crates/subscribe/build/worker/shim.mjs', 'apps/subscribe/dist/index.html']) {
  if (!existsSync(new URL(`../${path}`, import.meta.url))) throw new Error(`Missing verified artifact: ${path}`);
}

/** Execute pinned Wrangler via Node directly; no shell interpolation or local recompilation. */
function wrangler(...args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    cwd: root, stdio: 'inherit', timeout: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Wrangler ${args[0]} failed; later services were not released.`);
}

for (const service of ['billing', 'subscribe']) {
  wrangler('d1', 'migrations', 'apply', `moesegfault-${service}-staging`, '--remote', '--config', `wrangler.${service}.jsonc`);
  wrangler('deploy', '--config', `wrangler.${service}.jsonc`);
}
await import('./deployment-smoke.mjs');
