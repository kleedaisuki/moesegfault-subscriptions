/** Dependency-free administrator CLI contract tests; never contact remote services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { options, issue } from './admin-issue.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const intent = { id, origin: 'https://billing-staging.moesegfault.dev', body: { plan_id: 'pro' } };

test('defaults to staging and recovery cannot replace original request', () => {
  assert.deepEqual(options(['--plan', 'pro']), { plan: 'pro', origin: intent.origin });
  assert.deepEqual(options(['--resume', id]), { resume: id });
  assert.throws(() => options(['--resume', id, '--plan', 'new']));
  assert.throws(() => options(['--plan', 'pro', '--environment', 'https://evil.example']));
  assert.throws(() => options(['--plan', '../private']));
});

test('only a safe receipt is returned and redirects are forbidden', async () => {
  const status = await issue(intent, 'test-key', async (url, request) => {
    assert.equal(url, `${intent.origin}/v1/admin/activation-codes`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(request.headers['Idempotency-Key'], id);
    assert.deepEqual(JSON.parse(request.body), { plan_id: 'pro' });
    return Response.json({ status: 'sent', activation_code: 'must-not-escape' });
  });
  assert.equal(status, 'sent');
});

test('errors do not incorporate remote secret-bearing responses', async () => {
  await assert.rejects(issue(intent, 'test', async () => new Response('secret', { status: 500 })), { message: 'http_500' });
  await assert.rejects(issue(intent, 'test', async () => Response.json({ status: 'secret' })), { message: 'invalid_receipt' });
  await assert.rejects(issue({ ...intent, origin: 'https://evil.example' }, 'test'), { message: 'invalid_intent' });
});
