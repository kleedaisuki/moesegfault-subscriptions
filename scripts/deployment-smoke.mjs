#!/usr/bin/env node
/**
 * Bound post-release checks to deployed staging health, auth boundaries, and asset delivery.
 * Usage: npm run smoke:staging
 * User registration, email delivery, and redemption are acceptance journeys, not CI loops.
 */
import assert from 'node:assert/strict';

const endpoints = {
  billing: 'https://billing-staging.moesegfault.dev',
  subscribe: 'https://subscribe-staging.moesegfault.dev',
};

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
const session = await request(`${endpoints.subscribe}/api/session`);
assert.ok([200, 401].includes(session.status), 'Anonymous session is either safe guest projection or 401');
const account = await request(`${endpoints.billing}/v1/me`);
assert.equal(account.status, 401, 'Billing rejects missing subject credential');
process.stdout.write('Staging smoke passed: billing health, Subscribe HTML, guest session, protected billing.\n');
