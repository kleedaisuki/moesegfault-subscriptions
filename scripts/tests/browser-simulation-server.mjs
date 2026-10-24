/** Isolated loopback BFF fixture; all identities, codes and data are synthetic. */
import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const blank = { display_name: '', email: '', country: '', address_line1: '', address_line2: '', city: '', postal_code: '', tax_id: '' };
export const fixturePlans = JSON.parse(await readFile(resolve('infra/plans.staging.json'), 'utf8'));
const subscription = (id, product, plan) => ({ id, product_id: product, plan_id: plan, status: 'active', current_period_start: 1791129600, current_period_end: 1924992000, activation_source: 'activation_code' });

/** A factory lets browser checks own listener lifetime and use an ephemeral port. */
export async function startFixture({ port = 4397, artifacts = resolve('.temp/ui-simulation') } = {}) {
  const root = resolve('apps/subscribe/dist');
  await mkdir(artifacts, { recursive: true });
  let profile;
  let subscriptions;
  let authenticated;
  let loadFailures;
  let returnTo;
  const attempts = new Map();
  const events = [];
  function reset(seeded = false) {
    profile = { ...blank };
    subscriptions = seeded ? [subscription('fixture-platform', 'moesegfault-platform', 'platform-monthly'), subscription('fixture-amail', 'amail', 'amail-free')] : [];
    authenticated = true;
    loadFailures = 0;
    returnTo = 'https://example.com/fixture-complete';
    attempts.clear();
    events.length = 0;
  }
  reset();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(status === 204 ? undefined : JSON.stringify(data)); };
      if (url.pathname === '/__fixture/reset' && req.method === 'POST') { reset(Boolean(body?.seeded)); return json(200, { ok: true }); }
      if (url.pathname === '/__fixture/evidence') return json(200, events);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        const event = { path: url.pathname, search: url.search, method: req.method, body, csrf: req.headers['x-csrf-token'], key: req.headers['idempotency-key'] };
        events.push(event);
        await appendFile(resolve(artifacts, 'requests.jsonl'), JSON.stringify(event) + '\n');
      }
      if (url.pathname === '/api/session') {
        const requestedReturn = url.searchParams.get('return_to');
        if (requestedReturn === 'https://adash-staging.moesegfault.dev/billing/return') returnTo = requestedReturn;
        if (url.searchParams.get('scenario') === 'load-failure' && loadFailures++ === 0) return json(503, { error_code: 'temporarily_unavailable' });
        if (url.searchParams.get('scenario') === 'guest') authenticated = false;
        return json(200, authenticated ? { authenticated: true, csrfToken: 'synthetic-csrf', user: { sub: 'fixture-user', name: 'UI Simulation' }, returnTo } : { authenticated: false });
      }
      if (url.pathname === '/api/catalog') return json(200, { plans: fixturePlans });
      if (url.pathname === '/auth/login') {
        // Simulate an unsuccessful round trip without interacting with Identity.
        res.writeHead(302, { Location: '/?scenario=guest&auth_error=login_denied&locale=en' }); return res.end();
      }
      if (url.pathname === '/auth/logout') { authenticated = false; return json(204); }
      if (url.pathname.startsWith('/api/') && !authenticated) return json(401, { error_code: 'session_expired' });
      if (url.pathname === '/api/billing') return json(200, { account: { id: 'fixture-account', profile, created_at: 1791129600, updated_at: 1791129600 }, subscriptions });
      if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.headers['x-csrf-token'] !== 'synthetic-csrf') return json(403, { error_code: 'csrf_invalid' });
      if (url.pathname === '/api/profile' && req.method === 'PUT') { profile = body; return json(200, { account: { id: 'fixture-account', profile } }); }
      if (url.pathname === '/api/activate' && req.method === 'POST') {
        const n = (attempts.get(body.code) ?? 0) + 1; attempts.set(body.code, n);
        if (body.code.startsWith('RETRY') && n === 1) return json(503, { error_code: 'temporarily_unavailable' });
        if (body.code === 'BAD-CODE') return json(422, { error_code: 'activation_invalid' });
        const next = subscription('fixture-platform', 'moesegfault-platform', 'platform-monthly');
        subscriptions = [...subscriptions.filter(item => item.product_id !== next.product_id), next];
        return json(200, { subscription: next });
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error_code: 'not_found' });
      const path = resolve(root, '.' + url.pathname);
      if (path !== root && !path.startsWith(root + sep)) return json(400, { error_code: 'invalid_path' });
      const target = extname(path) ? path : resolve(root, 'index.html');
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' }); res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end('Fixture resource unavailable'); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { origin: `http://127.0.0.1:${server.address().port}`, events, close: () => new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); }) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fixture = await startFixture();
  console.log(`UI simulation fixture: ${fixture.origin}`);
}
