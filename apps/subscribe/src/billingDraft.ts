import type { BillingProfile } from './api';

const key = 'subscribe-billing-draft';
const lifetime = 10 * 60 * 1000;
const fields: (keyof BillingProfile)[] = ['display_name', 'email', 'country', 'address_line1', 'address_line2', 'city', 'postal_code', 'tax_id'];

/** Only an expired-session form is kept, in this tab, for the same verified subject. */
export function keepBillingDraft(subject: string | undefined, profile: BillingProfile): void {
  if (!subject) return;
  try { sessionStorage.setItem(key, JSON.stringify({ subject, expires: Date.now() + lifetime, profile })); }
  catch { /* Blocked storage does not prevent explicit sign-in. */ }
}

export function clearBillingDraft(): void {
  try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
}

export function takeBillingDraft(subject: string | undefined): BillingProfile | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const draft: unknown = JSON.parse(raw);
    clearBillingDraft();
    if (typeof draft !== 'object' || draft === null || !('subject' in draft) || draft.subject !== subject || !subject || !('expires' in draft) || typeof draft.expires !== 'number' || draft.expires <= Date.now() || !('profile' in draft) || typeof draft.profile !== 'object' || draft.profile === null) return undefined;
    const profile = draft.profile as Record<string, unknown>;
    if (!fields.every(field => typeof profile[field] === 'string' && (profile[field] as string).length <= 256)) return undefined;
    return Object.fromEntries(fields.map(field => [field, profile[field]])) as unknown as BillingProfile;
  } catch { clearBillingDraft(); return undefined; }
}
