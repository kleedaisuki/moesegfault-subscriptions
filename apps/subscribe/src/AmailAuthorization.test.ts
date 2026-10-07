import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthorizationDetails, ConsentCurrency, TariffDetails, currentUsd, moneyMicros, amailReturn, authorizationId, budgetMicros, type AmailAuthorizationView } from './AmailAuthorization';
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
    for (const input of ['-1', '1e9', 'NaN', 'Infinity', '1.234', '1000000000', '1000000.01', '', ' 1']) expect(budgetMicros(input)).toBeUndefined();
  });
  it('permits only the fixed staging completion URL, not agent-supplied continuations', () => {
    const allowed = 'https://amail-staging.moesegfault.dev/billing/return';
    expect(amailReturn(allowed)).toBe(allowed);
    for (const value of [`${allowed}?token=private`, `${allowed}#secret`, 'javascript:alert(1)', 'https://evil.test']) expect(amailReturn(value)).toBeUndefined();
  });
  it('explains payer binding and deferred settlement without claiming an automatic payment', () => {
    const view = { authorization: { expires_at: 1900000000, currency: 'USD', overage_budget_micros: 0 } } as AmailAuthorizationView;
    const html = renderToStaticMarkup(createElement(AuthorizationDetails, { view, payer: '<private payer>' }));
    expect(html).toContain('&lt;private payer&gt;');
    expect(html).toContain('绑定');
    expect(html).toContain('不进行自动扣款');
    expect(html).toContain('待结算');
    expect(html).toContain('Agent 不能自行提高');
  });
});

/** Historical CNY is never rendered as dollar consent; current tariff is authoritative and exact. */
describe('USD denomination boundary', () => {
  const view = { authorization: { id: 'opaque_authorization_identifier_123', product_id: 'amail', plan_id: 'amail-lite', status: 'pending', expires_at: 1900000000, return_url: 'https://amail-staging.moesegfault.dev/billing/return', currency: 'USD', contract_version: 'amail-v0.2.0-usd-v1', overage_budget_micros: 10_000 }, tariff: { currency: 'USD', contract_version: 'amail-v0.2.0-usd-v1', monthly_micros: { 'amail-free': 0, 'amail-lite': 1_500_000, 'amail-plus': 4_500_000 }, outbound_recipient_micros: 1000, storage_gb_month_micros: 150_000, address_month_micros: 500_000 }, plan: { id: 'amail-lite', product_id: 'amail', name: { 'zh-CN': 'Lite', en: 'Lite', ja: 'Lite' }, description: { 'zh-CN': '', en: '', ja: '' }, duration_days: 30, active: true, entitlements: ['amail.plan.lite'] }, settlement_mode: 'activation_code_and_accrual', requires_activation: false } satisfies AmailAuthorizationView;
  it('only permits the exact server-supplied current contract', () => {
    expect(currentUsd(view)).toBe(true);
    const html = renderToStaticMarkup(createElement(TariffDetails, { view }));
    expect(html).toContain('$0.001 USD');
    expect(html).toContain('$0.15 USD');
    expect(html).toContain('$0.50 USD');
    expect(renderToStaticMarkup(createElement(TariffDetails, { view: { ...view, tariff: null } }))).toBe('');
    expect(currentUsd({ ...view, tariff: null })).toBe(false);
    expect(currentUsd({ ...view, authorization: { ...view.authorization, currency: 'CNY' } })).toBe(false);
    expect(currentUsd({ ...view, tariff: { ...view.tariff!, address_month_micros: 3_000_000 } })).toBe(false);
  });
  it('uses exact integer micros and labels historical yuan without FX', () => {
    expect(moneyMicros(1_500_000, 'USD')).toBe('$1.50 USD');
    expect(moneyMicros(1_000, 'USD')).toBe('$0.001 USD');
    expect(moneyMicros(22, 'CNY')).toBe('¥0.000022 CNY');
    expect(budgetMicros('1000000.00')).toBe(1_000_000_000_000);
    const html = renderToStaticMarkup(createElement(ConsentCurrency, { view: { ...view, authorization: { ...view.authorization, currency: 'CNY', overage_budget_micros: 22 } } }));
    expect(html).toContain('¥0.000022 CNY');
    expect(html).toContain('只读保留');
    expect(html).toContain('已有套餐权益不受影响');
    expect(html).not.toContain('$');
  });
});
