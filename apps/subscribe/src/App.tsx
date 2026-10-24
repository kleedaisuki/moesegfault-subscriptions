import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, continuation, loginPath, mutate, request, type Billing, type BillingProfile, type Plan, type Session, type Subscription } from './api';
import { messages, persist, preference, resolveLocale, type Locale } from './i18n';
import { clearBillingDraft, keepBillingDraft, takeBillingDraft } from './billingDraft';
import './styles.css';

/** A profile never borrows an unverified email from OIDC claims. */
const emptyProfile: BillingProfile = { display_name: '', email: '', country: '', address_line1: '', address_line2: '', city: '', postal_code: '', tax_id: '' };

/** A 401 invalidates the local view; a CSRF 403 or network failure does not. */
export function authenticationStateAfterFailure(error: unknown, state: { session?: Session; billing?: Billing }): { session?: Session; billing?: Billing } {
  return error instanceof ApiError && error.status === 401
    ? { session: { authenticated: false }, billing: undefined }
    : state;
}

/** Only stable, allowlisted callback outcomes may select recovery copy. */
export function authRecoveryCode(search: string): 'login_denied' | 'login_failed' | undefined {
  const code = new URLSearchParams(search).get('auth_error');
  return code === 'login_denied' || code === 'login_failed' ? code : undefined;
}

/** Recovery is explicit user navigation, never an automatic sign-in redirect loop. */
export function AuthRecovery({ search, locale, authenticated, embedded }: { search: string; locale: Locale; authenticated: boolean; embedded: boolean }) {
  const code = authRecoveryCode(search);
  if (!code) return null;
  const t = messages[locale];
  return <div className="notice notice-error" role="alert">
    <p>{code === 'login_denied' ? t.loginDenied : t.loginFailed}</p>
    {authenticated && <p>{t.previousSession}</p>}
    <a href={loginPath(search)} target={embedded ? '_top' : undefined}>{t.loginRetry}</a>
  </div>;
}

/** A non-sensitive, tab-local marker bounds SSO even if a callback returns as a guest. */
export function claimAutomaticLogin(search: string, embedded: boolean): boolean {
  if (embedded || new URLSearchParams(search).has('auth_error')) return false;
  try {
    if (sessionStorage.getItem('subscribe-sso-attempted')) return false;
    sessionStorage.setItem('subscribe-sso-attempted', '1');
    return true;
  } catch { return false; }
}

export function suppressAutomaticLogin(): void {
  try { sessionStorage.setItem('subscribe-sso-attempted', '1'); } catch { /* Explicit login remains available. */ }
}

export function resetAutomaticLogin(): void {
  try { sessionStorage.removeItem('subscribe-sso-attempted'); } catch { /* No credentials are kept in browser storage. */ }
}

/** Localize actionable failure classes, not arbitrary server or vendor messages. */
export function errorMessage(error: unknown, locale: Locale): string {
  const t = messages[locale];
  if (!(error instanceof ApiError)) return t.networkError;
  if (error.status === 401) return t.sessionError;
  if (error.status === 403) return error.code.includes('csrf') ? t.csrfError : t.genericError;
  if (error.code === 'plan_conflict') return t.planConflict;
  if (error.status === 409) return t.conflictError;
  if (error.code.includes('code') || error.code.includes('activation')) return t.codeError;
  if (error.code.includes('profile') || error.status === 422) return t.invalidProfile;
  return t.genericError;
}

/** Accept the service's Unix-second or ISO timestamps without assuming host timezones. */
export function periodDate(value: string | number, locale: Locale): string {
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : undefined;
  const date = new Date(numeric === undefined ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** Status messages are exposed to assistive technology without raw service internals. */
function Notice({ error, success, locale }: { error?: unknown; success?: string; locale: Locale }) {
  if (!error && !success) return null;
  return <div className={`notice ${error ? 'notice-error' : 'notice-success'}`} role={error ? 'alert' : 'status'}>
    <p>{error ? errorMessage(error, locale) : success}</p>
    {error instanceof ApiError && error.status === 401 && <a href={loginPath(location.search)} target={new URLSearchParams(location.search).get('embedded') === '1' ? '_top' : undefined}>{messages[locale].signIn}</a>}
    {error instanceof ApiError && error.correlationId && <small>{messages[locale].reference}: <code>{error.correlationId}</code></small>}
  </div>;
}

export function productName(id: string, locale: Locale): string {
  if (id === 'amail') return 'amail';
  if (id === 'agents') return 'Agents';
  if (id === 'moesegfault-platform') return messages[locale].platform;
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function groupPlans(plans: Plan[]): { id: string; plans: Plan[] }[] {
  const products = new Map<string, Plan[]>();
  for (const plan of plans) {
    if (!plan.active) continue;
    const group = products.get(plan.product_id) ?? [];
    group.push(plan);
    products.set(plan.product_id, group);
  }
  return Array.from(products, ([id, items]) => ({ id, plans: items }));
}

export function SubscriptionList({ subscriptions, plans, locale, embedded = false }: { subscriptions: Subscription[]; plans: Plan[]; locale: Locale; embedded?: boolean }) {
  const t = messages[locale];
  if (!subscriptions.length) return <div className="empty-state"><span className="empty-icon" aria-hidden="true">◇</span><h3>{t.noSubscriptions}</h3><a href={embedded ? "/" : "#activate"} target={embedded ? "_top" : undefined}>{t.activate} <span aria-hidden="true">↗</span></a></div>;
  const catalog = new Map(plans.map(plan => [plan.id, plan]));
  return <div className="subscription-list">{subscriptions.map(subscription => {
    const plan = catalog.get(subscription.plan_id);
    const end = typeof subscription.current_period_end === 'number' ? subscription.current_period_end * 1000 : /^\d+$/.test(subscription.current_period_end) ? Number(subscription.current_period_end) * 1000 : subscription.current_period_end;
    const status = subscription.status === 'active' && new Date(end).getTime() <= Date.now() ? 'expired' : subscription.status;
    const label = ['active', 'expired', 'canceled', 'pending'].includes(status) ? t[status as 'active' | 'expired' | 'canceled' | 'pending'] : t.unknown;
    return <article key={subscription.id} className="subscription-row">
      <span className="product-icon" aria-hidden="true">{productName(subscription.product_id, locale).slice(0, 1)}</span>
      <div className="subscription-copy"><h3>{productName(subscription.product_id, locale)}</h3><p>{plan?.name[locale] || plan?.name.en || t.unavailablePlan}</p></div>
      <div className="subscription-period"><span className={"status-pill " + (status === 'active' ? 'status-active' : '')}>{label}</span><p className="muted">{t.until} {periodDate(subscription.current_period_end, locale)}</p></div>
    </article>;
  })}</div>;
}

export function ProductCatalog({ plans, locale, authenticated, requestedPlan, showHeading = true }: { plans: Plan[]; locale: Locale; authenticated: boolean; requestedPlan?: string | null; showHeading?: boolean }) {
  const t = messages[locale];
  const products = groupPlans(plans);
  return <section className="catalog" id="products" aria-labelledby={showHeading ? "catalog-title" : undefined} aria-label={showHeading ? undefined : t.catalog}>
    {showHeading && <div className="section-heading"><h2 id="catalog-title">{t.catalog}</h2></div>}
    {!products.length && <p className="muted">{t.noPlans}</p>}
    <div className="product-grid">{products.map(product => <article className="product-card" key={product.id}>
      <div className="product-heading"><span className="product-icon" aria-hidden="true">{productName(product.id, locale).slice(0, 1)}</span><h3>{productName(product.id, locale)}</h3></div>
      <div className="product-plans">{product.plans.map(plan => <details key={plan.id} className={"plan-option " + (requestedPlan === plan.id ? 'plan-requested' : '')} open={requestedPlan === plan.id || undefined}>
        <summary><span className="plan-name">{plan.name[locale] || plan.name.en}{requestedPlan === plan.id && <span className="requested-dot" aria-label={t.selected} />}</span><span className="plan-duration">{plan.duration_days} {t.days}</span><span className="disclosure" aria-hidden="true">⌄</span></summary>
        <div className="plan-details"><p className="muted">{plan.description[locale] || plan.description.en}</p><a href={authenticated ? '/#activate' : loginPath(location.search)}>{t.useCode} <span aria-hidden="true">↗</span></a></div>
      </details>)}</div>
    </article>)}</div>
  </section>;
}

/** Keep failed retries on the same idempotency key until code input changes.
 * An accepted return link is durable navigation, not evidence of a completed activation.
 */
export function ActivationForm({ session, locale, onActivated, onAuthenticationFailure }: { session: Session; locale: Locale; onActivated: () => Promise<void>; onAuthenticationFailure: (error: unknown) => void }) {
  const t = messages[locale];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [success, setSuccess] = useState(false);
  const attempt = useRef<{ code: string; key: string } | undefined>(undefined);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = code.trim();
    if (busy || !normalized) return;
    if (!attempt.current || attempt.current.code !== normalized) attempt.current = { code: normalized, key: crypto.randomUUID() };
    setBusy(true); setError(undefined); setSuccess(false);
    try {
      await mutate('/api/activate', 'POST', session.csrfToken ?? '', { code: normalized }, attempt.current.key);
      setSuccess(true); setCode(''); attempt.current = undefined;
      await onActivated();
    } catch (failure) {
      setError(failure);
      onAuthenticationFailure(failure);
      if (failure instanceof ApiError && failure.status < 500) attempt.current = undefined;
    } finally { setBusy(false); }
  }
  return <section className="panel activation-panel" id="activate" aria-labelledby="activate-title">
    <div className="section-heading"><h2 id="activate-title">{t.activationCode}</h2></div>
    <form onSubmit={submit}>
      <label className="sr-only" htmlFor="activation-code">{t.activationCode}</label>
      <div className="code-controls"><input id="activation-code" name="activation-code" value={code} onChange={event => { setCode(event.target.value); setSuccess(false); }} placeholder={t.codePlaceholder} required maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} /><button className="moe-button" disabled={busy || !code.trim()}>{busy ? t.activating : t.redeem}</button></div>
    </form>
    <Notice error={error} success={success ? t.activated : undefined} locale={locale} />
    {continuation(session) && <a className="return-link" href={continuation(session)}>{t.continue} <span aria-hidden="true">↗</span></a>}
  </section>;
}

function normalizeProfile(profile: BillingProfile): BillingProfile {
  return Object.fromEntries(Object.keys(emptyProfile).map(key => [key, profile[key as keyof BillingProfile] ?? ''])) as unknown as BillingProfile;
}

export function ProfileForm({ initial, session, locale, onAuthenticationFailure }: { initial: BillingProfile; session: Session; locale: Locale; onAuthenticationFailure: (error: unknown) => void }) {
  const t = messages[locale];
  const [draft] = useState(() => takeBillingDraft(session.user?.sub));
  const [stored, setStored] = useState(() => normalizeProfile(initial));
  const [profile, setProfile] = useState(draft ?? stored);
  const [editing, setEditing] = useState(Boolean(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined); setSaved(false);
    try {
      await mutate('/api/profile', 'PUT', session.csrfToken ?? '', profile);
      clearBillingDraft(); setStored(profile); setSaved(true); setEditing(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) keepBillingDraft(session.user?.sub, profile);
      setError(failure); onAuthenticationFailure(failure);
    } finally { setBusy(false); }
  }
  useEffect(() => { if (!editing) { const next = normalizeProfile(initial); setStored(next); setProfile(next); } }, [initial]);
  const autocomplete: Partial<Record<keyof BillingProfile, string>> = { display_name: 'name', email: 'email', country: 'country', address_line1: 'address-line1', address_line2: 'address-line2', city: 'address-level2', postal_code: 'postal-code' };
  const address = [stored.address_line1, stored.address_line2, [stored.city, stored.postal_code].filter(Boolean).join(' '), stored.country].filter(Boolean);
  return <section className="panel billing-panel" id="profile" aria-labelledby="profile-title">
    <div className="section-heading"><h2 id="profile-title">{t.profile}</h2>{!editing && <button type="button" className="text-button" onClick={() => { setProfile(stored); setEditing(true); setSaved(false); }}>{address.length || stored.display_name || stored.email ? t.edit : t.add}</button>}</div>
    {!editing ? <div className="address-summary"><address>{stored.display_name && <strong>{stored.display_name}</strong>}{address.map((line, index) => <span key={index}>{line}</span>)}{!address.length && <span className="muted">{t.noAddress}</span>}{stored.email && <span>{stored.email}</span>}{stored.tax_id && <span>{t.tax_id}: {stored.tax_id}</span>}</address></div> : <form onSubmit={submit} className="profile-form">
      <fieldset disabled={busy}><legend className="sr-only">{t.profile}</legend><div className="form-grid">
        {(Object.keys(emptyProfile) as (keyof BillingProfile)[]).map(key => <div className={"field " + (key.startsWith('address') || key === 'display_name' || key === 'email' ? 'field-wide' : '')} key={key}>
          <label htmlFor={"profile-" + key}>{t[key]}</label>
          <input id={"profile-" + key} name={key} value={profile[key] ?? ''} onChange={event => setProfile({ ...profile, [key]: key === 'country' ? event.target.value.toUpperCase() : event.target.value })} type={key === 'email' ? 'email' : 'text'} autoComplete={autocomplete[key] ?? 'off'} maxLength={key === 'country' ? 2 : key === 'email' ? 254 : 256} pattern={key === 'country' ? '[A-Z]{2}' : undefined} aria-describedby={key === 'country' ? 'country-hint' : undefined} />
          {key === 'country' && <small id="country-hint" className="muted">{t.countryHint}</small>}
        </div>)}
      </div></fieldset>
      <div className="form-footer"><button className="moe-button" disabled={busy}>{busy ? t.saving : t.save}</button><button type="button" className="text-button" disabled={busy} onClick={() => { clearBillingDraft(); setEditing(false); setError(undefined); }}>{t.cancel}</button></div>
    </form>}
    <Notice error={error} success={saved ? t.saved : draft && editing ? t.draftRestored : undefined} locale={locale} />
  </section>;
}

function SubscriptionPanel({ billing, plans, locale, session, embedded = false, onRefresh }: { billing?: Billing; plans: Plan[]; locale: Locale; session: Session; embedded?: boolean; onRefresh: () => Promise<void> }) {
  const t = messages[locale];
  return <section className="panel subscriptions-panel" id="subscriptions" aria-labelledby="subscriptions-title">
    <div className="section-heading"><h2 id="subscriptions-title" className={embedded ? '' : 'sr-only'}>{t.subscriptions}</h2><button className="text-button refresh-button" onClick={() => void onRefresh()}>{t.refresh}</button></div>
    {embedded && <p className="viewer muted">{t.signedInAs}: <strong>{session?.user?.name || session?.user?.sub}</strong></p>}
    {billing && <SubscriptionList subscriptions={billing.subscriptions} plans={plans} locale={locale} embedded={embedded} />}
    {embedded && <div className="embed-actions"><a className="moe-button" href="/" target="_top">{t.manage} <span aria-hidden="true">↗</span></a><a href="/auth/login?path=%2Faccount&prompt=select_account" target="_top">{t.reconnect}</a></div>}
  </section>;
}

export function AccountDashboard({ billing, plans, locale, session, onRefresh, onAuthenticationFailure }: { billing: Billing; plans: Plan[]; locale: Locale; session: Session; onRefresh: () => Promise<void>; onAuthenticationFailure: (error: unknown) => void }) {
  return <div className="dashboard">
    <SubscriptionPanel billing={billing} plans={plans} locale={locale} session={session} onRefresh={onRefresh} />
    <ActivationForm session={session} locale={locale} onActivated={onRefresh} onAuthenticationFailure={onAuthenticationFailure} />
    <ProfileForm key={billing.account.id} initial={billing.account.profile} session={session} locale={locale} onAuthenticationFailure={onAuthenticationFailure} />
  </div>;
}

/** A same-origin BFF is the sole trust boundary for this browser application. */
export default function App() {
  const query = new URLSearchParams(location.search);
  const browsing = location.pathname === '/products';
  const embedded = location.pathname === '/account' && query.get('embedded') === '1';
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(query.get('locale') ?? preference('subscribe-locale') ?? navigator.language));
  const [theme, setTheme] = useState(() => ['light', 'dark', 'auto'].includes(query.get('theme') ?? '') ? query.get('theme')! : preference('moe-theme') ?? 'auto');
  const [session, setSession] = useState<Session>();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<Billing>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const initialLoginChecked = useRef(false);
  const t = messages[locale];
  useEffect(() => { document.documentElement.lang = locale; document.title = `${browsing ? t.catalog : t.subscriptions} · moeSegFault`; persist('subscribe-locale', locale); }, [locale, t, browsing]);
  useEffect(() => { document.documentElement.dataset.moeTheme = theme; persist('moe-theme', theme); }, [theme]);
  function onAuthenticationFailure(error: unknown) {
    const current = { session, billing };
    const next = authenticationStateAfterFailure(error, current);
    if (next === current) return;
    setSession(next.session); setBilling(next.billing);
    setLoadError(undefined); setActionError(error);
  }
  async function refreshBilling() {
    try { setBilling(await request<Billing>('/api/billing')); setLoadError(undefined); }
    catch (error) { setLoadError(error); onAuthenticationFailure(error); }
  }
  async function load() {
    setLoading(true); setLoadError(undefined);
    try {
      const account = request<Session>(`/api/session${location.search}`).then(async nextSession => ({ session: nextSession, billing: nextSession.authenticated && !browsing ? await request<Billing>('/api/billing') : undefined }));
      const [next, catalog] = await Promise.all([account, request<{ plans: Plan[] }>('/api/catalog')]);
      setSession(next.session); setBilling(next.billing); setPlans(catalog.plans);
    } catch (error) { setLoadError(error); onAuthenticationFailure(error); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (loading || !session || initialLoginChecked.current) return;
    initialLoginChecked.current = true;
    if (session.authenticated) resetAutomaticLogin();
    else if (!browsing && !loadError && claimAutomaticLogin(location.search, embedded)) location.assign(loginPath(location.search));
  }, [loading, session, loadError, embedded, browsing]);
  async function logout() {
    setLogoutBusy(true); setActionError(undefined);
    try { await mutate('/auth/logout', 'POST', session?.csrfToken ?? ''); suppressAutomaticLogin(); setSession({ authenticated: false }); setBilling(undefined); }
    catch (error) { setActionError(error); onAuthenticationFailure(error); }
    finally { setLogoutBusy(false); }
  }
  const requestedPlan = query.get('plan');
  const viewerName = session?.user?.name || billing?.account.profile.display_name;
  const feedback = <><AuthRecovery search={location.search} locale={locale} authenticated={session?.authenticated ?? false} embedded={embedded} /><Notice error={actionError} locale={locale} />{loading && <div className="panel loading" role="status"><span className="loading-dot" aria-hidden="true" />{t.loading}</div>}{!loading && loadError && <div className="panel"><Notice error={loadError} locale={locale} /><button className="moe-button" onClick={() => void load()}>{t.retry}</button></div>}</>;
  const login = !loading && session && !session.authenticated && <section className="panel login-panel"><span className="login-emblem" aria-hidden="true">◇</span><h2>{t.loginTitle}</h2><a className="moe-button" href={loginPath(location.search)} target={embedded ? '_top' : undefined}>{t.signIn} <span aria-hidden="true">↗</span></a></section>;
  if (embedded) return <main className="embed-shell"><h1 className="sr-only">{t.accountTitle}</h1>{feedback}{login}{!loading && session?.authenticated && <SubscriptionPanel billing={billing} plans={plans} locale={locale} session={session} embedded onRefresh={refreshBilling} />}</main>;
  return <div className="app-shell">
    <a className="skip-link" href="#main">{t.subscriptions}</a>
    <header className="site-header"><a className="brand" href="/" aria-label="moeSegFault Subscribe"><span className="brand-mark" aria-hidden="true"><img src="/style/v0.1.2/icons/brand.svg" alt="" /></span><span>moeSegFault<span className="brand-product">Subscribe</span></span></a>
      <div className="header-controls"><label className="sr-only" htmlFor="language">{t.language}</label><select id="language" value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">简体中文</option><option value="ja">日本語</option><option value="en">English</option></select><label className="sr-only" htmlFor="theme">{t.theme}</label><select id="theme" value={theme} onChange={event => setTheme(event.target.value)}><option value="auto">◐ {t.auto}</option><option value="light">☀ {t.light}</option><option value="dark">☾ {t.dark}</option></select>{session?.authenticated && <button className="text-button" disabled={logoutBusy} onClick={() => void logout()}>{t.signOut}</button>}</div>
    </header>
    <main id="main"><div className="page-heading"><div><h1>{browsing ? t.catalog : t.accountTitle}</h1>{!browsing && viewerName && <p className="account-name">{viewerName}</p>}</div><a className="browse-link" href={browsing ? "/" : "/products"}>{browsing ? t.accountTitle : t.browseProducts} <span aria-hidden="true">{browsing ? "←" : "↗"}</span></a></div>
      {feedback}
      {!loading && (browsing ? <ProductCatalog plans={plans} locale={locale} authenticated={session?.authenticated ?? false} requestedPlan={requestedPlan} showHeading={false} /> : <>{login}{session?.authenticated && billing && <AccountDashboard billing={billing} plans={plans} locale={locale} session={session} onRefresh={refreshBilling} onAuthenticationFailure={onAuthenticationFailure} />}</>)}

    </main>
    <footer className="site-footer"><span>© {new Date().getFullYear()} moeSegFault</span><a href="mailto:subscribe@moesegfault.dev">{t.support} <span aria-hidden="true">↗</span></a></footer>
  </div>;
}
