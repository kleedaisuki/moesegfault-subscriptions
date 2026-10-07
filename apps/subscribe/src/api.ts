/** Browser-visible session only. OAuth credentials remain inside the BFF. */
export interface Session {
  authenticated: boolean;
  csrfToken?: string;
  user?: { sub: string; name?: string };
  returnTo?: string;
}

/** Locale keys match the deployment-owned plan catalog. */
export type LocalizedText = Record<'zh-CN' | 'en' | 'ja', string>;

/** Plans are configured server-side; activation codes select the actual grant. */
export interface Plan {
  id: string;
  product_id: string;
  name: LocalizedText;
  description: LocalizedText;
  duration_days: number;
  active: boolean;
  entitlements: string[];
}

/** Billing contact details are independent of Identity's mutable profile. */
export interface BillingProfile {
  display_name: string;
  email: string;
  country: string;
  address_line1: string;
  address_line2: string;
  city: string;
  postal_code: string;
  tax_id: string;
}

/** Billing periods are supplied by the authoritative billing service. */
export interface Subscription {
  id: string;
  product_id: string;
  plan_id: string;
  status: string;
  current_period_start: string | number;
  current_period_end: string | number;
  activation_source: string;
}

/** Aggregate response used for account and subscription views. */
export interface Billing {
  account: { id: string; profile: BillingProfile; created_at: string | number; updated_at: string | number };
  subscriptions: Subscription[];
}

/** Machine-readable problem details stay available without exposing raw server text. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public correlationId?: string) {
    super(code);
  }
}

/** Per-page trace root is memory-only and contains no account or authorization identifiers. */
let pageTraceId: string | undefined;

/** Fresh client span for each request, grouped under the current page's trace root. */
export function browserTraceparent(): string {
  const hex = (size: number) => Array.from(crypto.getRandomValues(new Uint8Array(size)), byte => byte.toString(16).padStart(2, '0')).join('');
  pageTraceId ??= hex(16);
  return `00-${pageTraceId}-${hex(8)}-01`;
}

/** Same-origin requests never store or forward bearer tokens in the browser. */
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { Accept: 'application/json', traceparent: browserTraceparent(), ...options.headers } });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem.error_code ?? problem.code ?? problem.error ?? 'request_failed', response.headers.get('x-moesegfault-correlation-id') ?? undefined);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** All mutations require the session's CSRF token, never a query-string value. */
export function mutate<T>(path: string, method: string, csrfToken: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  if (!csrfToken) return Promise.reject(new ApiError(401, 'session_expired'));
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Forward integration hints to the BFF; only it validates the continuation. */
export function loginPath(search: string, pathname = "/"): string {
  const input = new URLSearchParams(search);
  const output = new URLSearchParams();
  for (const key of ['app', 'plan', 'return_to']) {
    const value = input.get(key);
    if (value) output.set(key, value);
  }
  if (/^\/amail\/authorize\/[A-Za-z0-9_-]{24,128}$/.test(pathname)) {
    output.set('path', pathname);
  }
  if (input.get('embedded') === '1' && !pathname.startsWith('/amail/authorize/')) {
    output.set('path', '/account');
    output.set('embedded', '1');
    for (const key of ['locale', 'theme']) {
      const value = input.get(key);
      if (value) output.set(key, value);
    }
  }
  return `/auth/login${output.size ? `?${output}` : ''}`;
}

/** Additional scheme guard; authorization still belongs to the BFF allowlist. */
export function continuation(session: Session): string | undefined {
  if (!session.returnTo) return undefined;
  try {
    const url = new URL(session.returnTo);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}
