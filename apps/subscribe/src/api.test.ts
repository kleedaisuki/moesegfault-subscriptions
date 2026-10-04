import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApiError, continuation, loginPath, mutate, request } from './api';
import { errorMessage, periodDate } from './App';
import { messages, persist, preference, resolveLocale } from './i18n';

afterEach(() => vi.unstubAllGlobals());

describe('same-origin billing client', () => {
  it('preserves structured problem codes and support correlation without displaying server text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error_code: 'activation_code_invalid', detail: 'private implementation detail' }), { status: 400, headers: { 'x-moesegfault-correlation-id': 'test-reference' } })));
    await expect(request('/api/activate')).rejects.toMatchObject({ status: 400, code: 'activation_code_invalid', correlationId: 'test-reference' });
    expect(errorMessage(new ApiError(400, 'activation_code_invalid'), 'zh-CN')).toBe(messages['zh-CN'].codeError);
  });

  it('includes credentials, CSRF and a caller-owned idempotency key on activation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ replayed: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await mutate('/api/activate', 'POST', 'csrf-session', { code: 'MOE-test' }, 'retry-stable-key');
    expect(fetchMock).toHaveBeenCalledWith('/api/activate', expect.objectContaining({ credentials: 'same-origin', method: 'POST', body: '{"code":"MOE-test"}', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-session', 'Idempotency-Key': 'retry-stable-key' }) }));
  });

  it('does not issue a mutation without an application session CSRF token', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(mutate('/api/profile', 'PUT', '', {})).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an empty successful logout response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(mutate('/auth/logout', 'POST', 'csrf')).resolves.toBeUndefined();
  });
});

describe('integration boundaries', () => {
  it('only forwards known hints to login and leaves return URL validation to the BFF', () => {
    const path = loginPath('?app=notes&plan=pro&return_to=https%3A%2F%2Fnotes.example%2Fdone&token=private');
    const url = new URL(path, 'https://subscribe.example');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('return_to')).toBe('https://notes.example/done');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('keeps account embed context through login', () => {
    const url = new URL(loginPath('?embedded=1&locale=ja&theme=dark'), 'https://subscribe.example');
    expect(url.searchParams.get('path')).toBe('/account');
    expect(url.searchParams.get('locale')).toBe('ja');
    expect(url.searchParams.get('theme')).toBe('dark');
  });

  it('does not create a continuation from query input or permit executable schemes', () => {
    expect(continuation({ authenticated: true })).toBeUndefined();
    expect(continuation({ authenticated: true, returnTo: 'javascript:alert(1)' })).toBeUndefined();
    expect(continuation({ authenticated: true, returnTo: 'https://notes.example/done' })).toBe('https://notes.example/done');
  });
});

describe('internationalization and browser resilience', () => {
  it('uses only color and layout tokens supplied by the pinned platform styles', () => {
    const productCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const platformCss = ['tokens', 'foundation', 'components'].map(name => readFileSync(new URL(`../public/style/v0.1.2/${name}.css`, import.meta.url), 'utf8')).join('\n');
    const defined = new Set([...`${platformCss}\n${productCss}`.matchAll(/(--moe-[a-z0-9-]+)\s*:/g)].map(match => match[1]));
    const used = [...productCss.matchAll(/var\((--moe-[a-z0-9-]+)/g)].map(match => match[1]);
    expect(used.filter(token => !defined.has(token))).toEqual([]);
  });

  it('provides complete Chinese, Japanese and English UI catalogs', () => {
    for (const locale of ['zh-CN', 'ja', 'en'] as const) {
      expect(Object.keys(messages[locale])).toEqual(Object.keys(messages.en));
      expect(Object.values(messages[locale]).every(text => text.length > 0)).toBe(true);
    }
    expect(resolveLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('ja-JP')).toBe('ja');
    expect(resolveLocale('fr')).toBe('en');
  });

  it('does not fail when local storage is blocked in an iframe', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(preference('moe-theme')).toBeNull();
    expect(() => persist('moe-theme', 'dark')).not.toThrow();
  });

  it('renders Unix-second and ISO billing periods consistently', () => {
    expect(periodDate(1893456000, 'en')).toBe(periodDate('2030-01-01T00:00:00Z', 'en'));
    expect(periodDate('invalid', 'ja')).toBe('—');
  });

  it('offers localized and actionable errors for lost sessions and network failures', () => {
    expect(errorMessage(new ApiError(401, 'session_expired'), 'ja')).toBe(messages.ja.sessionError);
    expect(errorMessage(new TypeError('fetch failed'), 'en')).toBe(messages.en.networkError);
  });

  it('distinguishes active-plan conflicts from already redeemed codes', () => {
    expect(errorMessage(new ApiError(409, 'plan_conflict'), 'zh-CN')).toBe(messages['zh-CN'].planConflict);
    expect(errorMessage(new ApiError(409, 'code_redeemed'), 'en')).toBe(messages.en.conflictError);
  });
});
