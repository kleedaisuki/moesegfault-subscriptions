#!/usr/bin/env node
/**
 * Synchronize the human-editable staging plan catalog into the reviewed Wrangler variable.
 * Usage: npm run plans:sync; npm run plans:check
 * Matches the Rust registry's bounded metadata contract; never reinterpret a deployed plan ID.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Reject unknown fields, duplicate stable IDs, and invalid grants before editing configuration. */
export function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length < 1 || catalog.length > 100) throw new Error('Catalog must contain 1–100 plans.');
  const identifiers = new Set();
  const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);
  const fields = new Set(['id', 'product_id', 'name', 'description', 'duration_days', 'active', 'entitlements']);
  for (const plan of catalog) {
    if (!plan || Object.keys(plan).some((key) => !fields.has(key)) || !identifier(plan.id) || !identifier(plan.product_id) || identifiers.has(plan.id)) throw new Error('Invalid or duplicate plan identifier/field.');
    if (!Number.isSafeInteger(plan.duration_days) || plan.duration_days < 1 || plan.duration_days > 3650 || typeof plan.active !== 'boolean') throw new Error('Plan duration must be 1–3650 whole days and active must be boolean.');
    if (!Array.isArray(plan.entitlements) || plan.entitlements.length > 50 || !plan.entitlements.every(identifier)) throw new Error('Invalid entitlement identifiers.');
    for (const locale of ['zh-CN', 'en', 'ja']) {
      const name = plan.name?.[locale];
      const description = plan.description?.[locale];
      if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 256 || typeof description !== 'string' || Buffer.byteLength(description) > 2048) throw new Error('Each plan requires bounded Chinese, English, and Japanese localization.');
    }
    identifiers.add(plan.id);
  }
  return catalog;
}

/** Synchronize staging only, or fail without writing when invoked by a validation gate. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: deployment-plans.mjs [--check]');
  const configUrl = new URL('../wrangler.billing.jsonc', import.meta.url);
  const catalog = validateCatalog(JSON.parse(await readFile(new URL('../infra/plans.staging.json', import.meta.url), 'utf8')));
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  if (config.name !== 'moesegfault-billing-staging') throw new Error('Only staging catalog configuration is supported.');
  const value = JSON.stringify(catalog);
  if (args[0] === '--check' && config.vars.PLAN_REGISTRY_JSON !== value) throw new Error('Catalog differs from Worker configuration; run npm run plans:sync.');
  if (args[0] !== '--check' && config.vars.PLAN_REGISTRY_JSON !== value) {
    config.vars.PLAN_REGISTRY_JSON = value;
    await writeFile(configUrl, `${JSON.stringify(config, null, 2)}\n`);
  }
  process.stdout.write('Staging plan catalog and Worker configuration match.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
