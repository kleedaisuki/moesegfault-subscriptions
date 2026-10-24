import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountDashboard, ProductCatalog, ProfileForm, SubscriptionList, claimAutomaticLogin, groupPlans, productName, resetAutomaticLogin, suppressAutomaticLogin } from './App';
import { keepBillingDraft, takeBillingDraft } from './billingDraft';
import type { Billing, BillingProfile, Plan, Subscription } from './api';

const plans: Plan[] = JSON.parse(readFileSync(new URL('../../../infra/plans.staging.json', import.meta.url), 'utf8'));
const profile: BillingProfile = { display_name: 'Test Payer', email: 'payer@example.test', country: 'SG', address_line1: 'One test street', address_line2: '', city: 'Singapore', postal_code: '123456', tax_id: '' };

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
  vi.stubGlobal('location', { search: '' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('account and product hierarchy', () => {
  it('groups every active plan once under its product, including non-adjacent input', () => {
    for (const order of [plans, [...plans].reverse(), [...plans.slice(2), ...plans.slice(0, 2)]]) {
      const groups = groupPlans([...order, { ...plans[0], id: 'inactive', active: false }]);
      expect(groups).toHaveLength(3);
      expect(groups.flatMap(group => group.plans).map(plan => plan.id).sort()).toEqual(plans.map(plan => plan.id).sort());
      for (const group of groups) expect(group.plans.every(plan => plan.product_id === group.id)).toBe(true);
    }
  });

  it('renders three product cards, seven plan rows, and preserves every full description', () => {
    const html = renderToStaticMarkup(createElement(ProductCatalog, { plans, locale: 'en', authenticated: true, requestedPlan: 'amail-plus' }));
    expect(html.match(/class="product-card"/g)).toHaveLength(3);
    expect(html.match(/<details /g)).toHaveLength(plans.length);
    for (const plan of plans) expect(html).toContain(plan.description.en.replaceAll('&', '&amp;'));
    expect(html).toContain('plan-requested');
    expect(html).toContain('open=""');
    expect(html).not.toContain('moesegfault-platform');
    expect(productName('agents', 'ja')).toBe('Agents');
    expect(productName('future-product', 'en')).toBe('Future Product');
  });

  it('shows all user subscriptions, without exposing internal plan IDs', () => {
    const subscriptions: Subscription[] = ['amail-lite', 'agents-go'].map((id, index) => ({ id: String(index), product_id: plans.find(plan => plan.id === id)!.product_id, plan_id: id, status: 'active', current_period_start: 1800000000, current_period_end: '2000000000', activation_source: 'activation_code' }));
    const html = renderToStaticMarkup(createElement(SubscriptionList, { subscriptions, plans, locale: 'en' }));
    expect(html.match(/class="subscription-row"/g)).toHaveLength(2);
    expect(html.match(/status-active/g)).toHaveLength(2);
    expect(html).not.toContain('amail-lite');
    expect(html).not.toContain('agents-go');
  });

  it('does not turn the seven-plan catalog into subscriptions or unrelated account offerings', () => {
    const billing: Billing = { account: { id: 'payer', profile, created_at: 1800000000, updated_at: 1800000000 }, subscriptions: [] };
    const html = renderToStaticMarkup(createElement(AccountDashboard, { billing, plans, locale: 'en', session: { authenticated: true, user: { sub: 'payer' } }, onRefresh: async () => {}, onAuthenticationFailure: () => {} }));
    expect(plans).toHaveLength(7);
    expect(html).toContain('No subscriptions yet');
    expect(html).not.toContain('subscription-row');
    expect(html).not.toContain('product-card');
    expect(html).not.toContain('plan-option');
    expect(html).not.toContain('id="products"');
    expect(html).not.toContain('amail');
    expect(html).not.toContain('Agents');
    expect(html).toContain('id="activate"');
    expect(html.match(/id="profile"/g)).toHaveLength(1);
  });

  it('keeps actual expired and retired subscriptions without showing unowned catalog products', () => {
    const retired = { ...plans[0], active: false };
    const subscriptions: Subscription[] = [{ id: 'real-history', product_id: retired.product_id, plan_id: retired.id, status: 'expired', current_period_start: 1700000000, current_period_end: 1701000000, activation_source: 'activation_code' }];
    const billing: Billing = { account: { id: 'payer', profile, created_at: 1800000000, updated_at: 1800000000 }, subscriptions };
    const html = renderToStaticMarkup(createElement(AccountDashboard, { billing, plans: [retired, ...plans.slice(1)], locale: 'en', session: { authenticated: true, user: { sub: 'payer' } }, onRefresh: async () => {}, onAuthenticationFailure: () => {} }));
    expect(html.match(/class="subscription-row"/g)).toHaveLength(1);
    expect(html).toContain(retired.name.en);
    expect(html).toContain('Expired');
    expect(html).not.toContain('amail');
    expect(html).not.toContain('Agents');
  });

  it('links discovered authenticated plans to the account activation surface', () => {
    const html = renderToStaticMarkup(createElement(ProductCatalog, { plans, locale: 'en', authenticated: true, showHeading: false }));
    expect(html.match(/href="\/#activate"/g)).toHaveLength(7);
    expect(html).not.toContain('id="subscriptions"');
    expect(html).not.toContain('id="profile"');
    expect(html).not.toContain('id="activate"');
  });

  it('routes empty embedded subscription CTA out of the frame', () => {
    const html = renderToStaticMarkup(createElement(SubscriptionList, { subscriptions: [], plans, locale: 'en', embedded: true }));
    expect(html).toContain('href="/" target="_top"');
    expect(html).not.toContain('#activate');
  });

  it('renders one account-wide billing address summary without an always-open form', () => {
    const html = renderToStaticMarkup(createElement(ProfileForm, { initial: profile, session: { authenticated: true, user: { sub: 'payer' } }, locale: 'en', onAuthenticationFailure: () => {} }));
    expect(html).toContain('Billing address');
    expect(html).toContain('One test street');
    expect(html).toContain('payer@example.test');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('section-number');
  });
});

describe('bounded automatic SSO', () => {
  it('attempts one top-level SSO and resets only after a successful account load', () => {
    expect(claimAutomaticLogin('', false)).toBe(true);
    expect(claimAutomaticLogin('', false)).toBe(false);
    resetAutomaticLogin();
    expect(claimAutomaticLogin('?app=agents', false)).toBe(true);
    suppressAutomaticLogin();
    expect(claimAutomaticLogin('', false)).toBe(false);
  });

  it('never auto-navigates embedded, failed callback, or blocked-storage contexts', () => {
    expect(claimAutomaticLogin('', true)).toBe(false);
    expect(claimAutomaticLogin('?auth_error=login_denied', false)).toBe(false);
    expect(claimAutomaticLogin('?auth_error=unknown', false)).toBe(false);
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(claimAutomaticLogin('', false)).toBe(false);
  });
});

describe('expired billing form recovery', () => {
  it('restores only for the same verified subject and consumes the stored copy', () => {
    keepBillingDraft('payer', profile);
    expect(takeBillingDraft('payer')).toEqual(profile);
    expect(takeBillingDraft('payer')).toBeUndefined();
    keepBillingDraft('payer', profile);
    expect(takeBillingDraft('other-payer')).toBeUndefined();
    expect(takeBillingDraft('payer')).toBeUndefined();
  });

  it('discards drafts after ten minutes and ignores corrupt browser data', () => {
    vi.useFakeTimers();
    keepBillingDraft('payer', profile);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(takeBillingDraft('payer')).toBeUndefined();
    sessionStorage.setItem('subscribe-billing-draft', '{corrupt');
    expect(takeBillingDraft('payer')).toBeUndefined();
  });

  it('opens the restored address for review rather than claiming it is saved', () => {
    keepBillingDraft('payer', profile);
    const html = renderToStaticMarkup(createElement(ProfileForm, { initial: { ...profile, address_line1: 'Previously saved address' }, session: { authenticated: true, user: { sub: 'payer' } }, locale: 'en', onAuthenticationFailure: () => {} }));
    expect(html).toContain('value="One test street"');
    expect(html).toContain('unsaved billing address has been restored');
    expect(html).not.toContain('Billing profile saved.');
  });
});
