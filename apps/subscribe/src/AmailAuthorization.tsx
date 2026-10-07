import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, loginPath, mutate, request, type Plan, type Session, type Subscription } from './api';
import { ActivationForm, authRecoveryCode, errorMessage, periodDate } from './App';

/** Billing presents an opaque transaction, never an agent token or an OAuth credential. */
export interface AmailAuthorizationView {
  authorization: {
    id: string;
    product_id: 'amail';
    plan_id: string;
    currency: 'USD' | 'CNY';
    contract_version: 'amail-v0.2.0-usd-v1' | 'amail-v0.2.0';
    overage_budget_micros: number;
    status: 'pending' | 'approved' | 'cancelled' | 'expired';
    expires_at: number | string;
    return_url: string;
  };
  /** Current tariff comes from Billing, never the agent or payer profile. Historical CNY is null. */
  tariff: { currency: 'USD'; contract_version: 'amail-v0.2.0-usd-v1'; monthly_micros: Record<string, number>; outbound_recipient_micros: number; storage_gb_month_micros: number; address_month_micros: number } | null;
  plan: Plan;
  subscription?: Subscription | null;
  settlement_mode: 'activation_code_and_accrual';
  requires_activation: boolean;
}

/** Parse decimal dollars exactly; never accept exponents, negative values or unsafe integers. */
export function budgetMicros(value: string): number | undefined {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(2, '0')) * 10_000;
  return Number.isSafeInteger(result) && result <= 1_000_000_000_000 ? result : undefined;
}

/** Format integer micros without binary floating-point rounding or denomination inference. */
export function moneyMicros(amount: number, currency: 'USD' | 'CNY'): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('invalid_money');
  const whole = Math.floor(amount / 1_000_000);
  const fraction = String(amount % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${currency === 'USD' ? '$' : '¥'}${whole}.${fraction} ${currency}`;
}

/** Fail closed if the hosted response does not contain the exact reviewed current dollar tariff. */
export function currentUsd(view: AmailAuthorizationView): boolean {
  const tariff = view.tariff;
  return view.authorization.currency === 'USD' && view.authorization.contract_version === 'amail-v0.2.0-usd-v1'
    && tariff?.currency === 'USD' && tariff.contract_version === 'amail-v0.2.0-usd-v1'
    && tariff.monthly_micros['amail-free'] === 0 && tariff.monthly_micros['amail-lite'] === 1_500_000
    && tariff.monthly_micros['amail-plus'] === 4_500_000 && tariff.outbound_recipient_micros === 1_000
    && tariff.storage_gb_month_micros === 150_000 && tariff.address_month_micros === 500_000;
}

/** Render only Billing's validated fixed tariff; never guess prices from a display name. */
export function TariffDetails({ view }: { view: AmailAuthorizationView }) {
  if (!currentUsd(view) || !view.tariff) return null;
  return <p>收信不按封收费；不限制邮件条数和语义搜索次数。超额发信 {moneyMicros(view.tariff.outbound_recipient_micros, view.tariff.currency)}/收件人、存储 {moneyMicros(view.tariff.storage_gb_month_micros, view.tariff.currency)}/GB·月、地址 {moneyMicros(view.tariff.address_month_micros, view.tariff.currency)}/个·月，按实际用量累计。</p>;
}

/** Historical receipts retain their original denomination; old consent cannot authorize new dollars. */
export function ConsentCurrency({ view }: { view: AmailAuthorizationView }) {
  return <p className="notice">授权币种：{view.authorization.currency}；月度超额预算：{moneyMicros(view.authorization.overage_budget_micros, view.authorization.currency)}。
    {view.authorization.currency === 'CNY' && '这是历史人民币请求，只读保留，不兑换成美元。请从 amail 发起新的美元授权；已有套餐权益不受影响。'}</p>;
}

/** Completion navigation is fixed and cannot be supplied by the requesting agent or query. */
export function amailReturn(value: string): string | undefined {
  return value === 'https://amail-staging.moesegfault.dev/billing/return' ? value : undefined;
}

/** Request identifiers remain in memory; no analytics, persistent browser storage, or logging. */
export function authorizationId(pathname: string): string | undefined {
  return /^\/amail\/authorize\/([A-Za-z0-9_-]{24,128})$/.exec(pathname)?.[1];
}

/** Display the actual human-controlled grant; the agent's selection is only a proposal. */
export function AuthorizationDetails({ view, payer }: { view: AmailAuthorizationView; payer: string }) {
  return <>
    <p>当前 Billing 付款账户：<strong>{payer}</strong></p>
    <p>授权后，该付款账户将绑定到发起此次请求的 amail 账户。请仅批准你自己刚刚发起的请求。</p>
    <p className="notice" role="note">当前使用激活码开通付费套餐。超额用量会累计为待结算账目；本次授权不进行自动扣款，也不代表已经完成付款。</p>
    <ConsentCurrency view={view} />
    <p className="muted">请求有效期至 {periodDate(view.authorization.expires_at, 'zh-CN')}。Agent 不能自行提高你授权的月度超额预算。</p>
  </>;
}

/** Human-only hosted consent, using the existing same-origin cookie and CSRF boundary. */
export default function AmailAuthorization() {
  const id = authorizationId(location.pathname);
  const login = loginPath(location.search, location.pathname);
  const [session, setSession] = useState<Session>();
  const [view, setView] = useState<AmailAuthorizationView>();
  const [plan, setPlan] = useState('amail-free');
  const [budget, setBudget] = useState('0');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [loaded, setLoaded] = useState(false);
  const endpoint = `/api/amail/authorizations/${id}`;
  async function refresh(initialize = false) {
    const next = await request<AmailAuthorizationView>(endpoint);
    setView(next);
    if (initialize) {
      setPlan(next.authorization.plan_id);
      setBudget(String(next.authorization.overage_budget_micros / 1_000_000));
    }
  }
  function failed(failure: unknown) {
    setError(failure);
    if (failure instanceof ApiError && failure.status === 401) {
      setSession({ authenticated: false }); setView(undefined);
    }
  }
  useEffect(() => {
    document.documentElement.lang = 'zh-CN';
    document.title = '授权 amail 订阅 · moeSegFault';
    if (!id) { setLoaded(true); return; }
    void (async () => {
      try {
        const next = await request<Session>('/api/session'); setSession(next);
        if (next.authenticated) await refresh(true);
      } catch (failure) { failed(failure); }
      finally { setLoaded(true); }
    })();
  }, []);
  async function act(action: 'approve' | 'cancel', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const amount = budgetMicros(budget);
    if (busy || (action === 'approve' && (!view || !currentUsd(view) || !acknowledged || amount === undefined))) return;
    setBusy(true); setError(undefined);
    try {
      await mutate(`${endpoint}/${action}`, 'POST', session?.csrfToken ?? '', action === 'approve' ? { acknowledge: true, plan_id: plan, overage_budget_micros: amount, currency: 'USD' } : {});
      await refresh();
    } catch (failure) { failed(failure); }
    finally { setBusy(false); }
  }
  const pending = view?.authorization.status === 'pending' && currentUsd(view);
  const status = view?.authorization.status;
  return <div className="app-shell authorization-shell"><header className="site-header"><a className="brand" href="/">moeSegFault Subscribe</a></header><main id="main">
    <section className="panel authorization-panel"><p className="eyebrow">amail / HUMAN AUTHORIZATION</p><h1>授权 amail 订阅</h1>
      {authRecoveryCode(location.search) && <p className="notice notice-error" role="alert">登录或切换账户未完成。当前显示的可能仍是之前的付款账户，请核对后重新登录。</p>}
      {session?.authenticated && <a href={login}>切换 Billing 付款账户</a>}
      {!id && <p role="alert">授权链接无效，请让 Agent 重新发起请求。</p>}
      {!loaded && <p role="status">正在加载授权请求…</p>}
      {error !== undefined && <div className="notice notice-error" role="alert"><p>{error instanceof ApiError && error.code.includes('activation') ? '请先使用对应套餐激活码开通，再重试授权。' : errorMessage(error, 'zh-CN')}</p>{error instanceof ApiError && error.correlationId && <small>支持参考：<code>{error.correlationId}</code></small>}<button className="moe-button" disabled={busy} onClick={() => { setError(undefined); void refresh().catch(failed); }}>重试加载</button></div>}
      {loaded && id && session && !session.authenticated && <><p>请登录 Billing 付款账户，由你本人确认套餐和预算。</p><a className="moe-button" href={login}>登录并继续</a></>}
      {session?.authenticated && view && <>
        <AuthorizationDetails view={view} payer={session.user?.name || session.user?.sub || '已登录账户'} />
        {pending ? <form onSubmit={event => void act('approve', event)}>
          <fieldset disabled={busy}><legend>确认套餐和月度超额预算</legend>
            <label htmlFor="amail-plan">套餐</label><select id="amail-plan" value={plan} onChange={event => { setPlan(event.target.value); setAcknowledged(false); }}>{(['free', 'lite', 'plus'] as const).map(name => <option key={name} value={`amail-${name}`}>{name[0].toUpperCase() + name.slice(1)} · {moneyMicros(view.tariff!.monthly_micros[`amail-${name}`], view.tariff!.currency)}/月</option>)}</select>
            <p>Free：100 封 / 200 MB / 1 地址；Lite：1,000 封 / 2 GB / 3 地址；Plus：5,000 封 / 10 GB / 5 地址。</p>
            <TariffDetails view={view} />
            <label htmlFor="amail-budget">月度超额预算（美元 USD，0 表示不开启超额）</label><input id="amail-budget" inputMode="decimal" value={budget} onChange={event => { setBudget(event.target.value); setAcknowledged(false); }} required pattern="[0-9]{1,9}(\.[0-9]{1,2})?" />
            <label className="consent-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />我确认将上述 Billing 付款账户绑定到此次请求的 amail 账户，并授权所选套餐和月度超额预算。</label>
          </fieldset>
          <div className="form-footer"><button className="moe-button" disabled={busy || !acknowledged || budgetMicros(budget) === undefined}>{busy ? '处理中…' : '确认授权'}</button><button type="button" className="text-button" disabled={busy} onClick={() => void act('cancel')}>取消请求</button></div>
        </form> : <div className="notice" role="status"><p>{status === 'approved' ? '授权已完成。请回到 amail，Agent 将从服务端查询授权结果。' : status === 'pending' ? '该请求不是当前美元计价合约，不能批准。请从 amail 发起新的美元授权。' : status === 'expired' ? '请求已过期，请让 Agent 重新发起。' : '请求已取消，没有批准此次绑定。'}</p>{status === 'approved' && amailReturn(view.authorization.return_url) && <a className="moe-button" href={amailReturn(view.authorization.return_url)}>返回 amail</a>}</div>}
        {pending && plan !== 'amail-free' && <><p>付费套餐需要已生效的对应激活码订阅。激活成功后仍需点击“确认授权”，不会自动绑定。</p><ActivationForm session={{ ...session, returnTo: undefined }} locale="zh-CN" onActivated={() => refresh()} onAuthenticationFailure={failed} /></>}
      </>}
    </section>
  </main></div>;
}
