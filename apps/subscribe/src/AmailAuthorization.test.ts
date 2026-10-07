import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthorizationDetails, amailReturn, authorizationId, budgetMicros, type AmailAuthorizationView } from './AmailAuthorization';
import { loginPath } from './api';

describe('hosted amail authorization boundaries', () => {
  it('preserves only opaque authorization context through top-level sign-in', () => {
    const id = 'opaque_authorization_identifier_123';
    const login = new URL(loginPath('?token=private&auth_error=login_denied', `/amail/authorize/${id}`), 'https://subscribe.example');
    expect(login.searchParams.get('path')).toBe(`/amail/authorize/${id}`);
    expect(login.searchParams.has('authorization_id')).toBe(false);
    expect(login.searchParams.has('token')).toBe(false);
    expect(login.searchParams.has('auth_error')).toBe(false);
    expect(authorizationId(`/amail/authorize/${id}`)).toBe(id);
    for (const search of ['/amail/authorize/short', `/amail/authorize/${id}/extra`, '/amail/authorize/../../../private', '/amail/authorize/%3Cscript%3E']) expect(authorizationId(search)).toBeUndefined();
  });
  it('converts human decimal budgets exactly without accepting unbounded or executable numeric input', () => {
    expect(budgetMicros('0')).toBe(0);
    expect(budgetMicros('12.34')).toBe(12_340_000);
    expect(budgetMicros('0.01')).toBe(10_000);
    for (const input of ['-1', '1e9', 'NaN', 'Infinity', '1.234', '1000000000', '', ' 1']) expect(budgetMicros(input)).toBeUndefined();
  });
  it('permits only the fixed staging completion URL, not agent-supplied continuations', () => {
    const allowed = 'https://amail-staging.moesegfault.dev/billing/return';
    expect(amailReturn(allowed)).toBe(allowed);
    for (const value of [`${allowed}?token=private`, `${allowed}#secret`, 'javascript:alert(1)', 'https://evil.test']) expect(amailReturn(value)).toBeUndefined();
  });
  it('explains payer binding and deferred settlement without claiming an automatic payment', () => {
    const view = { authorization: { expires_at: 1900000000 } } as AmailAuthorizationView;
    const html = renderToStaticMarkup(createElement(AuthorizationDetails, { view, payer: '<private payer>' }));
    expect(html).toContain('&lt;private payer&gt;');
    expect(html).toContain('绑定');
    expect(html).toContain('不进行自动扣款');
    expect(html).toContain('待结算');
    expect(html).toContain('Agent 不能自行提高');
  });
});
