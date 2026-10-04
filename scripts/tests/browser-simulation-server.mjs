/** Isolated loopback BFF fixture for product UI tests; never uses real credentials. */
import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve('apps/subscribe/dist');
const artifacts = resolve('.temp/ui-simulation');
await mkdir(artifacts, { recursive: true });
const blank = { display_name: '', email: '', country: '', address_line1: '', address_line2: '', city: '', postal_code: '', tax_id: '' };
let profile = { ...blank };
let subscriptions = [];
const attempts = new Map();
let loadFailures = 0;
const plan = { id: 'fixture-monthly', product_id: 'fixture', name: { 'zh-CN': '模拟月度套餐', ja: 'シミュレーション月額プラン', en: 'Simulation monthly plan' }, description: { 'zh-CN': '仅用于本地界面测试', ja: 'ローカル画面テスト専用', en: 'Local interface test only' }, duration_days: 30, active: true, entitlements: ['fixture.read'] };

/** Record only synthetic fixture requests to make UI mutation claims reproducible. */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4397');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname.startsWith('/api/')) {
      await appendFile(resolve(artifacts, 'requests.jsonl'), JSON.stringify({ path: url.pathname, method: req.method, body, csrf: req.headers['x-csrf-token'], key: req.headers['idempotency-key'] }) + '\n');
    }
    if (url.pathname === '/api/session') {
      if (url.searchParams.get('scenario') === 'load-failure' && loadFailures++ === 0) return json(503, { error_code: 'temporarily_unavailable' });
      return json(200, { authenticated: true, csrfToken: 'synthetic-csrf', user: { sub: 'fixture-user', name: 'UI Simulation' }, returnTo: 'https://example.com/fixture-complete' });
    }
    if (url.pathname === '/api/catalog') return json(200, { plans: [plan] });
    if (url.pathname === '/api/billing') return json(200, { account: { id: 'fixture-account', profile, created_at: 1791129600, updated_at: 1791129600 }, subscriptions });
    if (url.pathname === '/api/profile' && req.method === 'PUT') { profile = body; return json(200, { profile }); }
    if (url.pathname === '/api/activate' && req.method === 'POST') {
      const n = (attempts.get(body.code) ?? 0) + 1; attempts.set(body.code, n);
      if (body.code.startsWith('RETRY') && n === 1) return json(503, { error_code: 'temporarily_unavailable' });
      if (body.code === 'BAD-CODE') return json(422, { error_code: 'activation_invalid' });
      subscriptions = [{ id: 'fixture-sub', product_id: 'fixture', plan_id: plan.id, status: 'active', current_period_start: 1791129600, current_period_end: 1793808000, activation_source: 'activation_code' }];
      return json(200, { subscriptions });
    }
    if (url.pathname === '/auth/logout') return json(204, undefined);
    const path = resolve(root, '.' + url.pathname);
    if (!path.startsWith(root)) return json(400, { error_code: 'invalid_path' });
    const target = extname(path) ? path : resolve(root, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    const bytes = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' }); res.end(bytes);
  } catch { if (!res.headersSent) res.writeHead(404); res.end('Fixture resource unavailable'); }
});
server.listen(4397, '127.0.0.1', () => console.log('UI simulation fixture: http://127.0.0.1:4397'));
