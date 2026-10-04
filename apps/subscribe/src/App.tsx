import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, continuation, loginPath, mutate, request, type Billing, type BillingProfile, type Plan, type Session, type Subscription } from './api';
import { messages, persist, preference, resolveLocale, type Locale } from './i18n';
import './styles.css';

/** A profile never borrows an unverified email from OIDC claims. */
const emptyProfile: BillingProfile = { display_name: '', email: '', country: '', address_line1: '', address_line2: '', city: '', postal_code: '', tax_id: '' };

/** Localize actionable failure classes, not arbitrary server or vendor messages. */
export function errorMessage(error: unknown, locale: Locale): string {
  const t = messages[locale];
  if (!(error instanceof ApiError)) return t.networkError;
  if (error.status === 401 || error.status === 403) return t.sessionError;
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
    {error instanceof ApiError && (error.status === 401 || error.status === 403) && <a href={loginPath(location.search)} target={new URLSearchParams(location.search).get('embedded') === '1' ? '_top' : undefined}>{messages[locale].signIn}</a>}
    {error instanceof ApiError && error.correlationId && <small>{messages[locale].reference}: <code>{error.correlationId}</code></small>}
  </div>;
}

/** Read-only account embed and main portal share the same authoritative subscription list. */
function SubscriptionList({ subscriptions, plans, locale }: { subscriptions: Subscription[]; plans: Plan[]; locale: Locale }) {
  const t = messages[locale];
  if (!subscriptions.length) return <div className="empty-state"><span aria-hidden="true">◇</span><p>{t.noSubscriptions}</p></div>;
  return <div className="subscription-list">{subscriptions.map(subscription => {
    const plan = plans.find(item => item.id === subscription.plan_id);
    const status = subscription.status === 'active' && new Date(typeof subscription.current_period_end === 'number' ? subscription.current_period_end * 1000 : subscription.current_period_end).getTime() <= Date.now() ? 'expired' : subscription.status;
    const label = ['active', 'expired', 'canceled', 'pending'].includes(status) ? t[status as 'active' | 'expired' | 'canceled' | 'pending'] : t.unknown;
    return <article key={subscription.id} className="subscription-row">
      <div><p className="eyebrow">{subscription.product_id}</p><h3>{plan?.name[locale] || plan?.name.en || subscription.plan_id}</h3><p className="muted">{t.until} {periodDate(subscription.current_period_end, locale)}</p></div>
      <span className={`status-pill ${status === 'active' ? 'status-active' : ''}`}>{label}</span>
    </article>;
  })}</div>;
}

/** Keep failed network retries on the same idempotency key until code input changes. */
function ActivationForm({ session, locale, onActivated }: { session: Session; locale: Locale; onActivated: () => Promise<void> }) {
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
      if (failure instanceof ApiError && failure.status < 500) attempt.current = undefined;
    } finally { setBusy(false); }
  }
  return <section className="panel activation-panel" id="activate" aria-labelledby="activate-title">
    <div className="section-heading"><span className="section-number" aria-hidden="true">02</span><h2 id="activate-title">{t.activate}</h2></div>
    <form onSubmit={submit}>
      <label htmlFor="activation-code">{t.activationCode}</label>
      <div className="code-controls"><input id="activation-code" name="activation-code" value={code} onChange={event => { setCode(event.target.value); setSuccess(false); }} placeholder={t.codePlaceholder} required maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="code-hint" disabled={busy} /><button className="moe-button" disabled={busy || !code.trim()}>{busy ? t.activating : t.redeem}</button></div>
      <p id="code-hint" className="muted hint">{t.codeHint}</p>
    </form>
    <Notice error={error} success={success ? t.activated : undefined} locale={locale} />
    {success && continuation(session) && <a className="moe-button" href={continuation(session)}>{t.continue} <span aria-hidden="true">↗</span></a>}
  </section>;
}

/** Only explicitly entered billing details are sent to the service. */
function ProfileForm({ initial, session, locale }: { initial: BillingProfile; session: Session; locale: Locale }) {
  const t = messages[locale];
  const [profile, setProfile] = useState<BillingProfile>(() => Object.fromEntries(Object.keys(emptyProfile).map(key => [key, initial[key as keyof BillingProfile] ?? ''])) as unknown as BillingProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined); setSaved(false);
    try { await mutate('/api/profile', 'PUT', session.csrfToken ?? '', profile); setSaved(true); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const autocomplete: Partial<Record<keyof BillingProfile, string>> = { display_name: 'organization', email: 'email', country: 'country', address_line1: 'address-line1', address_line2: 'address-line2', city: 'address-level2', postal_code: 'postal-code' };
  return <section className="panel" id="profile" aria-labelledby="profile-title">
    <div className="section-heading"><span className="section-number" aria-hidden="true">03</span><h2 id="profile-title">{t.profile}</h2></div>
    <p className="muted">{t.profileHint}</p>
    <form onSubmit={submit} className="profile-form">
      <fieldset disabled={busy}><legend className="sr-only">{t.profile}</legend><div className="form-grid">
        {(Object.keys(emptyProfile) as (keyof BillingProfile)[]).map(key => <div className={`field ${key.startsWith('address') ? 'field-wide' : ''}`} key={key}>
          <label htmlFor={`profile-${key}`}>{t[key]}</label>
          <input id={`profile-${key}`} name={key} value={profile[key] ?? ''} onChange={event => { setProfile({ ...profile, [key]: key === 'country' ? event.target.value.toUpperCase() : event.target.value }); setSaved(false); }} type={key === 'email' ? 'email' : 'text'} autoComplete={autocomplete[key] ?? 'off'} maxLength={key === 'country' ? 2 : key === 'email' ? 254 : 256} pattern={key === 'country' ? '[A-Z]{2}' : undefined} aria-describedby={key === 'country' ? 'country-hint' : undefined} />
          {key === 'country' && <small id="country-hint" className="muted">{t.countryHint}</small>}
        </div>)}
      </div></fieldset>
      <div className="form-footer"><button className="moe-button" data-variant="secondary" disabled={busy}>{busy ? t.saving : t.save}</button><small className="muted">{t.privacy}</small></div>
    </form>
    <Notice error={error} success={saved ? t.saved : undefined} locale={locale} />
  </section>;
}

/** A same-origin BFF is the sole trust boundary for this browser application. */
export default function App() {
  const query = new URLSearchParams(location.search);
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
  const t = messages[locale];
  useEffect(() => { document.documentElement.lang = locale; document.title = `${t.subscriptions} · moeSegFault`; persist('subscribe-locale', locale); }, [locale, t]);
  useEffect(() => { document.documentElement.dataset.moeTheme = theme; persist('moe-theme', theme); }, [theme]);
  async function refreshBilling() {
    try { setBilling(await request<Billing>('/api/billing')); setLoadError(undefined); }
    catch (error) { setLoadError(error); }
  }
  async function load() {
    setLoading(true); setLoadError(undefined);
    try {
      const [nextSession, catalog] = await Promise.all([request<Session>(`/api/session${location.search}`), request<{ plans: Plan[] }>('/api/catalog')]);
      setSession(nextSession); setPlans(catalog.plans);
      if (nextSession.authenticated) setBilling(await request<Billing>('/api/billing'));
      else setBilling(undefined);
    } catch (error) { setLoadError(error); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function logout() {
    setLogoutBusy(true); setActionError(undefined);
    try { await mutate('/auth/logout', 'POST', session?.csrfToken ?? ''); setSession({ authenticated: false }); setBilling(undefined); }
    catch (error) { setActionError(error); }
    finally { setLogoutBusy(false); }
  }
  const requestedPlan = query.get('plan');
  const viewerName = session?.user?.name || session?.user?.sub;
  const content = <>
    {loading && <div className="panel loading" role="status"><span className="loading-dot" aria-hidden="true" />{t.loading}</div>}
    {!loading && loadError && <div className="panel"><Notice error={loadError} locale={locale} /><button className="moe-button" onClick={() => void load()}>{t.retry}</button></div>}
    {!loading && session && !session.authenticated && <section className="panel login-panel"><div className="login-emblem" aria-hidden="true">◇</div><h2>{t.loginTitle}</h2><p className="muted">{t.loginBody}</p><a className="moe-button" href={loginPath(location.search)} target={embedded ? '_top' : undefined}>{t.signIn} <span aria-hidden="true">↗</span></a></section>}
    {!loading && session?.authenticated && <>
      <section className="panel" id="subscriptions" aria-labelledby="subscriptions-title"><div className="section-heading"><span className="section-number" aria-hidden="true">01</span><h2 id="subscriptions-title">{t.subscriptions}</h2><button className="text-button refresh-button" onClick={() => void refreshBilling()}>{t.refresh}</button></div>
        <p className="viewer muted">{t.signedInAs}: <strong>{viewerName}</strong></p>
        {billing && <SubscriptionList subscriptions={billing.subscriptions} plans={plans} locale={locale} />}
        {embedded && <div className="embed-actions"><a className="moe-button" href="/" target="_top">{t.manage} <span aria-hidden="true">↗</span></a><a href="/account?reconnect=1" target="_top">{t.reconnect}</a></div>}
      </section>
      {!embedded && <ActivationForm session={session} locale={locale} onActivated={refreshBilling} />}
      {!embedded && billing && <ProfileForm initial={billing.account.profile} session={session} locale={locale} />}
    </>}
  </>;
  if (embedded) return <main className="embed-shell"><h1 className="sr-only">{t.accountTitle}</h1>{content}</main>;
  return <div className="app-shell">
    <a className="skip-link" href="#main">{t.subscriptions}</a>
    <header className="site-header"><a className="brand" href="/" aria-label="moeSegFault Subscribe"><span className="brand-mark" aria-hidden="true"><img src="/style/v0.1.2/icons/brand.svg" alt="" /></span><span>moeSegFault<span className="brand-product">Subscribe</span></span></a>
      <div className="header-controls"><label className="sr-only" htmlFor="language">{t.language}</label><select id="language" value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="zh-CN">简体中文</option><option value="ja">日本語</option><option value="en">English</option></select><label className="sr-only" htmlFor="theme">{t.theme}</label><select id="theme" value={theme} onChange={event => setTheme(event.target.value)}><option value="auto">◐ {t.auto}</option><option value="light">☀ {t.light}</option><option value="dark">☾ {t.dark}</option></select>{session?.authenticated && <button className="text-button" disabled={logoutBusy} onClick={() => void logout()}>{t.signOut}</button>}</div>
    </header>
    <main id="main"><section className="hero"><div className="hero-copy"><p className="eyebrow">moeSegFault / Subscribe</p><h1>{t.title}</h1><p className="hero-description">{t.subtitle}</p><ol className="steps" aria-label={t.steps}><li><span>1</span>{t.step1}</li><li><span>2</span>{t.step2}</li><li><span>3</span>{t.step3}</li></ol></div><div className="hero-art" aria-hidden="true"><div className="orb orb-one" /><div className="orb orb-two" /><span className="art-star star-one">✦</span><span className="art-star star-two">✧</span><div className="membership-card"><span>moeSegFault</span><img className="card-symbol" src="/style/v0.1.2/icons/brand.svg" alt="" /><div className="card-lines"><i /><i /></div><small>MEMBERSHIP</small></div></div></section>
      <Notice error={actionError} locale={locale} />
      <div className="content-grid"><div className="main-column">{content}</div><aside className="catalog" aria-labelledby="catalog-title"><div className="catalog-heading"><p className="eyebrow">PLANS</p><h2 id="catalog-title">{t.catalog}</h2></div>{!loading && !plans.filter(plan => plan.active).length && <p className="muted">{t.noPlans}</p>}{plans.filter(plan => plan.active).map(plan => <article key={plan.id} className={`plan-card ${plan.id === requestedPlan ? 'plan-requested' : ''}`}><p className="eyebrow">{plan.product_id}</p><h3>{plan.name[locale] || plan.name.en}</h3><p className="muted">{plan.description[locale] || plan.description.en}</p><div className="plan-duration"><strong>{plan.duration_days}</strong> {t.days}</div>{plan.id === requestedPlan && <span className="status-pill">{t.selected}</span>}<a className="plan-link" href={session?.authenticated ? '#activate' : loginPath(location.search)}>{session?.authenticated ? t.activate : t.signIn}<span aria-hidden="true">↗</span></a></article>)}</aside></div>
    </main>
    <footer className="site-footer"><span>© {new Date().getFullYear()} moeSegFault</span><a href="mailto:subscribe@moesegfault.dev">{t.support} <span aria-hidden="true">↗</span></a></footer>
  </div>;
}
