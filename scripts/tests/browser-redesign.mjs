/** Reproducible browser journey against the built UI and an isolated synthetic BFF. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './browser-simulation-server.mjs';

const module = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(isAbsolute(module) ? pathToFileURL(module).href : module);
const artifacts = resolve('.temp/ui-redesign');
await mkdir(artifacts, { recursive: true });
const runtime = resolve(artifacts, 'runtime');
await mkdir(runtime, { recursive: true });
const previousTemp = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]]));
for (const key of Object.keys(previousTemp)) process.env[key] = runtime;
const fixture = await startFixture({ port: 0, artifacts });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const results = [];
const pageErrors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
const check = (name, assertion) => { assertion(); results.push(name); console.log(`PASS: ${name}`); };
const profileEvents = () => fixture.events.filter(event => event.path === '/api/profile');
const activate = async code => {
  await page.locator('#activation-code').fill(code);
  const response = page.waitForResponse(value => value.url().endsWith('/api/activate'));
  await page.locator('#activate button').click();
  await response;
  await page.locator('#activation-code:not([disabled])').waitFor();
};
try {
  await context.request.post(fixture.origin + '/__fixture/reset', { data: { seeded: true } });
  await page.goto(fixture.origin + '/?locale=en&theme=light&plan=amail-plus');
  await page.locator('.subscription-row').first().waitFor();

  assert.equal(await page.locator('.subscription-row').count(), 2);
  assert.equal(await page.locator('.product-card').count(), 3);
  assert.equal(await page.locator('.plan-option').count(), 7);
  assert.deepEqual(await page.locator('.product-card').evaluateAll(cards => cards.map(card => card.querySelectorAll('.plan-option').length)), [1, 3, 3]);
  results.push('Two user subscriptions, three product groups, seven real catalog plans');
  assert.equal(await page.locator('#profile').count(), 1);
  assert.equal(await page.locator('#profile input').count(), 0);
  assert.equal(await page.locator('.hero, .steps, .section-number').count(), 0);
  assert.equal(await page.locator('.plan-requested').getAttribute('open'), '');
  assert.match(await page.locator('.plan-requested').innerText(), /authorized usage pending settlement/);
  results.push('One collapsed account-wide billing address; requested plan terms remain accessible');

  await page.locator('#profile button').click();
  await page.locator('#profile-display_name').fill('Synthetic UI Customer');
  await page.locator('#profile-email').fill('fixture@example.invalid');
  await page.locator('#profile-country').fill('cn');
  await page.locator('#profile-address_line1').fill('42 Synthetic Lane');
  await page.locator('#profile-city').fill('Example City');
  await page.locator('#profile-postal_code').fill('123456');
  await page.locator('#profile button[type=submit], #profile button.moe-button').first().click();
  await page.locator('#profile address strong').waitFor();
  check('Billing save is account-wide and normalizes country', () => {
    assert.equal(profileEvents().length, 1);
    assert.equal(profileEvents()[0].body.country, 'CN');
    assert.equal(profileEvents()[0].body.display_name, 'Synthetic UI Customer');
  });
  await page.locator('#profile button').click();
  await page.locator('#profile-display_name').fill('Unsaved draft');
  await page.locator('#profile').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.match(await page.locator('#profile address').innerText(), /Synthetic UI Customer/);
  await page.locator('#profile button').click();
  assert.equal(await page.locator('#profile-display_name').inputValue(), 'Synthetic UI Customer');
  await page.locator('#profile-email').fill('not-an-email');
  await page.locator('#profile button.moe-button').click();
  assert.equal(await page.locator('#profile-email').evaluate(input => input.validity.typeMismatch), true);
  assert.equal(profileEvents().length, 1);
  await page.locator('#profile').getByRole('button', { name: 'Cancel', exact: true }).click();
  results.push('Cancel discards unsaved draft; native email validation prevents PUT');

  await activate('RETRY-A');
  await page.locator('#activate [role=alert]').waitFor();
  await activate('RETRY-A');
  await page.locator('#activate [role=status]').waitFor();
  const retry = fixture.events.filter(event => event.path === '/api/activate' && event.body.code === 'RETRY-A');
  assert.equal(retry.length, 2);
  assert.equal(retry[0].key, retry[1].key);
  assert.equal(await page.locator('.subscription-row').count(), 2);
  await activate('RETRY-B');
  await page.locator('#activate [role=alert]').waitFor();
  await activate('RETRY-C');
  await page.locator('#activate [role=alert]').waitFor();
  const keyOf = code => fixture.events.find(event => event.path === '/api/activate' && event.body.code === code).key;
  assert.notEqual(keyOf('RETRY-B'), keyOf('RETRY-C'));
  await activate('BAD-CODE');
  await page.locator('#activate [role=alert]').waitFor();
  assert.equal(await page.locator('#activation-code').inputValue(), 'BAD-CODE');
  check('Activation retry retains key; edited code rotates key; invalid code stays editable', () => {
    assert.ok(fixture.events.filter(event => event.path.startsWith('/api/') && event.method !== 'GET').every(event => event.csrf === 'synthetic-csrf'));
  });

  await page.reload();
  await page.locator('#profile address strong').waitFor();
  assert.match(await page.locator('#profile address').innerText(), /42 Synthetic Lane/);
  assert.equal(await page.locator('a[href="https://example.com/fixture-complete"]').count(), 1);
  assert.equal(await page.locator('.subscription-row').count(), 2);
  await page.screenshot({ path: resolve(artifacts, 'en-light-desktop.png'), fullPage: true });
  results.push('Reload preserves subscriptions, billing address and Return to app navigation');

  for (const locale of ['zh-CN', 'ja', 'en']) {
    await page.locator('#language').selectOption(locale);
    assert.equal(await page.locator('html').getAttribute('lang'), locale);
    await page.locator('#theme').selectOption('dark');
    assert.equal(await page.locator('html').getAttribute('data-moe-theme'), 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${locale} mobile overflow`);
    await page.screenshot({ path: resolve(artifacts, `${locale}-dark-mobile.png`), fullPage: true });
  }
  results.push('Chinese/Japanese/English, dark theme and 390px mobile without horizontal overflow');
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px overflow`);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('#profile button').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '320px edit form overflow');
  await page.locator('#profile').getByRole('button', { name: 'Cancel', exact: true }).click();
  const disclosure = page.locator('.plan-option').first().locator('summary');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.evaluate(summary => summary.parentElement.open), true);
  results.push('320–1440px layouts and narrow edit form fit; keyboard opens native plan disclosure');
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(fixture.origin + '/account?embedded=1&locale=ja&theme=dark');
  await page.locator('.subscription-row').first().waitFor();
  assert.equal(await page.locator('input,form').count(), 0);
  assert.equal(await page.locator('.product-card').count(), 0);
  for (const link of await page.locator('.embed-actions a').all()) assert.equal(await link.getAttribute('target'), '_top');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: resolve(artifacts, 'account-ja-dark-mobile.png'), fullPage: true });
  results.push('Account embed remains read-only with top-level management and switch-account links');

  await page.goto(fixture.origin + '/?locale=en&scenario=load-failure');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.locator('.subscription-row').first().waitFor();
  results.push('Initial session 503 recovers through visible retry');

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in', exact: false }).first().waitFor();
  assert.equal(await page.locator('.subscription-row,#profile,#activate').count(), 0);
  assert.equal(fixture.events.filter(event => event.path === '/auth/login').length, 0);
  results.push('Explicit logout removes private account state without immediately auto-signing in');

  await page.goto(fixture.origin + '/account?embedded=1&locale=en&scenario=guest');
  await page.getByRole('link', { name: 'Sign in', exact: false }).first().waitFor();
  assert.equal(fixture.events.filter(event => event.path === '/auth/login').length, 0);
  assert.equal(await page.locator('.login-panel a').getAttribute('target'), '_top');
  results.push('Guest Account embed never initiates iframe SSO');

  await page.evaluate(() => sessionStorage.removeItem('subscribe-sso-attempted'));
  await page.goto(fixture.origin + '/?locale=en&scenario=guest&app=fixture');
  await page.waitForURL('**auth_error=login_denied**');
  await page.getByRole('alert').waitFor();
  assert.equal(fixture.events.filter(event => event.path === '/auth/login').length, 1);
  await page.reload();
  await page.getByRole('alert').waitFor();
  assert.equal(fixture.events.filter(event => event.path === '/auth/login').length, 1);
  results.push('Integration guest attempts top-level SSO once; denied callback and reload do not loop');
  await context.request.post(fixture.origin + '/__fixture/reset', { data: { seeded: true } });
  await page.goto(fixture.origin + '/?locale=en');
  await page.locator('.subscription-row').first().waitFor();
  await page.route('**/api/activate', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error_code: 'csrf_invalid' }) }));
  await activate('CSRF-FAIL');
  await page.locator('#activate [role=alert]').waitFor();
  assert.equal(await page.locator('.subscription-row').count(), 2);
  assert.equal(await page.locator('#profile').count(), 1);
  await page.unroute('**/api/activate');
  await page.route('**/api/activate', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error_code: 'session_expired' }) }));
  await page.locator('#activation-code').fill('SESSION-EXPIRED');
  await page.locator('#activate button').click();
  await page.locator('.login-panel').waitFor();
  assert.equal(await page.locator('.subscription-row,#profile,#activate').count(), 0);
  assert.equal(await page.locator('a[href="https://example.com/fixture-complete"]').count(), 0);
  assert.equal(fixture.events.filter(event => event.path === '/auth/login').length, 0);
  results.push('CSRF 403 preserves account state; 401 clears private state and return link without SSO loop');
  await page.unroute('**/api/activate');
  await page.goto(fixture.origin + '/?locale=en');
  await page.locator('#profile button').waitFor();
  await page.route('**/api/profile', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error_code: 'session_expired' }) }));
  await page.locator('#profile button').click();
  await page.locator('#profile-display_name').fill('Expiry draft customer');
  await page.locator('#profile-address_line1').fill('Expiry draft address');
  await page.locator('#profile button.moe-button').click();
  await page.locator('.login-panel').waitFor();
  assert.match(await page.evaluate(() => sessionStorage.getItem('subscribe-billing-draft')), /Expiry draft customer/);
  await page.unroute('**/api/profile');
  await page.goto(fixture.origin + '/?locale=en');
  await page.locator('#profile-display_name').waitFor();
  assert.equal(await page.locator('#profile-display_name').inputValue(), 'Expiry draft customer');
  assert.equal(await page.locator('#profile-address_line1').inputValue(), 'Expiry draft address');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('subscribe-billing-draft')), null);
  await page.locator('#profile button.moe-button').click();
  await page.locator('#profile address strong').waitFor();
  assert.match(await page.locator('#profile address').innerText(), /Expiry draft customer/);
  results.push('Billing-save 401 restores same-subject draft after reauthentication; successful save clears draft');
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ results, pageErrors, fixtureOnly: true }, null, 2));
  console.log(`PASS: ${results.length} browser journey assertions; artifacts ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(artifacts, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
  throw error;
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
  for (const [key, value] of Object.entries(previousTemp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
