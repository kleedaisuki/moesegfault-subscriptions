/** Prove authentication diagnostics cannot become a channel for callback capabilities or PII. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDiagnostic } from '../deployment-auth-tail.mjs';
import { readFile } from 'node:fs/promises';

test('tail emits only categorical constants and accepts the pinned Wrangler pretty log prefix', () => {
  assert.equal(sanitizeDiagnostic('  (warn) identity_verification_rejected stage=nonce category=invalid_identity_credentials'), 'identity_verification_rejected stage=nonce category=invalid_identity_credentials');
  assert.equal(sanitizeDiagnostic('\x1b[33m(warn) identity_verification_rejected stage=webcrypto category=identity_verification_unavailable\x1b[0m'), 'identity_verification_rejected stage=webcrypto category=identity_verification_unavailable');
});

test('tail disables Wrangler hidden disk logging before a child can receive callback events', async () => {
  const source = await readFile(new URL('../deployment-auth-tail.mjs', import.meta.url), 'utf8');
  assert.match(source, /WRANGLER_WRITE_LOGS: 'false'/);
  assert.match(source, /WRANGLER_LOG_SANITIZE: 'true'/);
  assert.match(source, /stdio: \['ignore', 'pipe', 'pipe'\]/);
});

test('tail drops URLs, unknown categories, identifiers, exceptions and appended context', () => {
  for (const line of [
    'GET https://subscribe-staging.moesegfault.dev/auth/callback?code=private - Ok',
    '{"event":{"request":{"url":"secret"}}}',
    'identity_verification_rejected stage=nonce category=invalid_identity_credentials token=private',
    'identity_verification_rejected stage=unknown category=invalid_identity_credentials',
    'identity_verification_rejected stage=nonce category=private',
    'identity_verification_rejected stage=nonce category=invalid_identity_credentials\nsecret',
    'Error: private token failed',
  ]) assert.equal(sanitizeDiagnostic(line), null);
});
