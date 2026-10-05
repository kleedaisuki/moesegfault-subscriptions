#!/usr/bin/env node
/**
 * Bound post-release checks to explicit environment health, auth boundaries, and asset delivery.
 * Usage: npm run smoke:staging; npm run smoke:production
 * User registration, email delivery, and redemption are acceptance journeys, not CI loops.
 */
import assert from 'node:assert/strict';

const target = process.argv[2] ?? process.env.DEPLOYMENT_SMOKE_TARGET ?? 'staging';
if (!['staging', 'production'].includes(target)) throw new Error('Smoke target must be staging or production.');
const suffix = target === 'staging' ? '-staging' : '';
const endpoints = { billing: `https://billing${suffix}.moesegfault.dev`, subscribe: `https://subscribe${suffix}.moesegfault.dev` };

/** Bound initial-domain DNS propagation and edge rollout retries to at most 90 seconds. */
async function request(url, init = {}) {
  let failure;
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt += 1) {
    try {
      const timeout = Math.max(1, Math.min(8_000, deadline - Date.now()));
      const response = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeout) });
      if (response.status >= 500) throw new Error(`HTTP ${response.status} at ${url}`);
      return response;
    } catch (error) {
      failure = error;
      if (attempt < 9 && Date.now() + 8_000 < deadline) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw failure;
}

const billing = await request(`${endpoints.billing}/healthz`);
assert.equal(billing.status, 200, 'Billing health');
const bffHealth = await request(`${endpoints.subscribe}/healthz`);
assert.equal(bffHealth.status, 200, 'Subscribe health');
assert.match(bffHealth.headers.get('content-type') ?? '', /json/, 'Health is JSON, never SPA fallback');
const home = await request(endpoints.subscribe, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
assert.equal(home.status, 200, 'Subscribe HTML');
assert.match(home.headers.get('content-type') ?? '', /text\/html/, 'HTML media type');
assert.match(await home.text(), /<html/i, 'HTML document');
assert.ok(home.headers.get('content-security-policy')?.includes(`frame-ancestors 'self' https://account${suffix}.moesegfault.dev`), 'HTML uses its own Account frame policy');
const session = await request(`${endpoints.subscribe}/api/session`);
assert.ok([200, 401].includes(session.status), 'Anonymous session is either safe guest projection or 401');
const account = await request(`${endpoints.billing}/v1/me`);
assert.equal(account.status, 401, 'Billing rejects missing subject credential');
process.stdout.write(`${target} smoke passed: billing health, Subscribe HTML/CSP, guest session, protected billing.\n`);
