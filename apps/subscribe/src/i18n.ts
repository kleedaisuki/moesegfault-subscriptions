/** Product locales are intentionally small and complete; unsupported locales fall back to English. */
export type Locale = 'zh-CN' | 'ja' | 'en';

const en = {
  title: 'Manage your subscriptions.', subtitle: 'Manage your subscriptions in one place. Activate a plan with a code, then return to your app.',
  subscriptions: 'Subscriptions', activate: 'Activate a plan', profile: 'Billing profile', signIn: 'Sign in', signOut: 'Sign out',
  loginTitle: 'One account. Your subscriptions.', loginBody: 'Sign in with moeSegFault to see your plans and redeem an activation code.',
  loginFailed: 'Sign-in wasn’t completed. Please try again.', loginDenied: 'Sign-in was canceled. Sign in again to continue.', loginRetry: 'Try signing in again', previousSession: 'The subscriptions shown still belong to your previously signed-in account.',
  language: 'Language', theme: 'Appearance', light: 'Light', dark: 'Dark', auto: 'System',
  loading: 'Loading your subscriptions…', loadError: 'We couldn’t load your subscriptions. Please try again.', retry: 'Try again',
  catalog: 'Available plans', days: 'days', selected: 'Requested plan', select: 'Choose plan',
  noPlans: 'No plans are available yet.', noSubscriptions: 'No subscriptions yet. Have a code? Activate your first plan below.',
  active: 'Active', expired: 'Expired', canceled: 'Canceled', pending: 'Pending', unknown: 'Not active', until: 'Valid until',
  activationCode: 'Activation code', codeHint: 'Your code determines the plan. Each code can be redeemed once.', codePlaceholder: 'Enter your activation code',
  redeem: 'Activate', activating: 'Activating…', activated: 'Your plan is active.', continue: 'Return to app', manage: 'Manage subscriptions',
  profileHint: 'Contact and billing details for your subscriptions. No card or payment method is required.',
  display_name: 'Full name or organization', email: 'Billing email', country: 'Country / region', countryHint: 'Two-letter code, e.g. CN or JP',
  address_line1: 'Address line 1', address_line2: 'Address line 2', city: 'City', postal_code: 'Postal code', tax_id: 'Tax ID (optional)',
  save: 'Save profile', saving: 'Saving…', saved: 'Billing profile saved.', support: 'Need help?', service: 'moeSegFault Subscribe',
  codeError: 'This code is invalid, expired, or already redeemed. Check the code or contact the sender.',
  sessionError: 'Your session has expired. Sign in again to continue.', networkError: 'Couldn’t connect. Check your connection and try again.',
  genericError: 'This action couldn’t be completed. Please try again.', conflictError: 'This code has already been used. Refresh your subscriptions before trying again.',
  planConflict: 'Your current plan is still active. Use this plan’s code after it expires. This code has not been redeemed.',
  reference: 'Support reference', refresh: 'Refresh', signedInAs: 'Subscription service account', privacy: 'Your billing profile is separate from your sign-in account.',
  steps: 'How it works', step1: 'Sign in', step2: 'Enter your code', step3: 'Return to your app',
  accountTitle: 'Your subscriptions', accountHint: 'Plans activated with your subscription service account.', reconnect: 'Switch account',
  allPlans: 'All plans', required: 'Required', invalidProfile: 'Please check your billing details.',
};

type Messages = typeof en;

const zh: Messages = {
  title: '管理你的订阅。', subtitle: '在这里管理订阅，使用激活码开启套餐，再回到你的应用。',
  subscriptions: '我的订阅', activate: '激活套餐', profile: '账单资料', signIn: '登录', signOut: '退出登录',
  loginTitle: '一个账号，管理你的订阅。', loginBody: '使用 moeSegFault 账号登录，查看套餐或兑换激活码。',
  loginFailed: '登录未完成，请重试。', loginDenied: '登录授权已取消，请重新登录后继续。', loginRetry: '重新登录', previousSession: '当前仍显示之前登录账号的订阅。',
  language: '语言', theme: '外观', light: '浅色', dark: '深色', auto: '跟随系统',
  loading: '正在加载订阅…', loadError: '暂时无法加载订阅，请重试。', retry: '重试',
  catalog: '可用套餐', days: '天', selected: '请求的套餐', select: '选择套餐',
  noPlans: '暂时没有可用套餐。', noSubscriptions: '你还没有订阅。有激活码？在下方开启第一个套餐。',
  active: '生效中', expired: '已到期', canceled: '已取消', pending: '待生效', unknown: '未生效', until: '有效期至',
  activationCode: '激活码', codeHint: '激活码决定实际开通的套餐。每个激活码仅可兑换一次。', codePlaceholder: '输入你的激活码',
  redeem: '激活', activating: '正在激活…', activated: '套餐已生效。', continue: '返回应用', manage: '管理订阅',
  profileHint: '用于订阅的联系与账单资料，无需提供银行卡或支付方式。',
  display_name: '姓名或组织名称', email: '账单邮箱', country: '国家 / 地区', countryHint: '两位字母代码，如 CN 或 JP',
  address_line1: '地址', address_line2: '补充地址', city: '城市', postal_code: '邮政编码', tax_id: '税号（选填）',
  save: '保存资料', saving: '正在保存…', saved: '账单资料已保存。', support: '需要帮助？', service: 'moeSegFault 订阅',
  codeError: '激活码无效、已过期或已兑换。请核对激活码，或联系发码方。',
  sessionError: '登录已过期，请重新登录后继续。', networkError: '连接失败，请检查网络后重试。',
  genericError: '操作暂时未能完成，请重试。', conflictError: '这个激活码已被使用。请刷新订阅后再试。',
  planConflict: '当前套餐仍在有效期内，请到期后使用此套餐激活码。激活码尚未使用。',
  reference: '客服参考编号', refresh: '刷新', signedInAs: '订阅服务账号', privacy: '账单资料与登录账号资料分别管理。',
  steps: '开通步骤', step1: '登录账号', step2: '输入激活码', step3: '返回应用',
  accountTitle: '我的订阅', accountHint: '以下套餐属于当前订阅服务账号。', reconnect: '切换账号',
  allPlans: '全部套餐', required: '必填', invalidProfile: '请检查账单资料。',
};

const ja: Messages = {
  title: 'サブスクリプションの管理。', subtitle: 'サブスクリプションをひとつの場所で管理。コードでプランを有効にして、アプリに戻りましょう。',
  subscriptions: 'サブスクリプション', activate: 'プランを有効にする', profile: '請求先情報', signIn: 'ログイン', signOut: 'ログアウト',
  loginTitle: 'ひとつのアカウントで管理。', loginBody: 'moeSegFault にログインして、プランの確認やコードの引き換えを行います。',
  loginFailed: 'ログインを完了できませんでした。もう一度お試しください。', loginDenied: 'ログインがキャンセルされました。続行するには再度ログインしてください。', loginRetry: 'ログインを再試行', previousSession: '表示中のサブスクリプションは、以前ログインしたアカウントのものです。',
  language: '言語', theme: '表示', light: 'ライト', dark: 'ダーク', auto: 'システム',
  loading: 'サブスクリプションを読み込み中…', loadError: '読み込めませんでした。もう一度お試しください。', retry: '再試行',
  catalog: '利用可能なプラン', days: '日', selected: 'リクエストされたプラン', select: 'プランを選択',
  noPlans: '現在利用できるプランはありません。', noSubscriptions: 'まだサブスクリプションはありません。コードをお持ちなら、下で有効にできます。',
  active: '有効', expired: '期限切れ', canceled: 'キャンセル済み', pending: '開始待ち', unknown: '無効', until: '有効期限',
  activationCode: 'アクティベーションコード', codeHint: 'コードによって有効になるプランが決まります。各コードは一度のみ利用できます。', codePlaceholder: 'コードを入力',
  redeem: '有効にする', activating: '有効化中…', activated: 'プランが有効になりました。', continue: 'アプリに戻る', manage: 'サブスクリプションを管理',
  profileHint: 'サブスクリプションの連絡先と請求先情報です。カードや支払い方法は不要です。',
  display_name: '氏名または組織名', email: '請求先メール', country: '国 / 地域', countryHint: 'CN、JP などの 2 文字コード',
  address_line1: '住所', address_line2: '建物名・部屋番号', city: '市区町村', postal_code: '郵便番号', tax_id: '納税者番号（任意）',
  save: '情報を保存', saving: '保存中…', saved: '請求先情報を保存しました。', support: 'お困りですか？', service: 'moeSegFault Subscribe',
  codeError: 'コードが無効、期限切れ、または使用済みです。コードを確認するか、発行者にお問い合わせください。',
  sessionError: 'ログインの有効期限が切れました。再度ログインしてください。', networkError: '接続できませんでした。通信状況を確認して再試行してください。',
  genericError: '操作を完了できませんでした。もう一度お試しください。', conflictError: 'このコードは使用済みです。サブスクリプションを更新してご確認ください。',
  planConflict: '現在のプランはまだ有効です。有効期限が切れてから、このプランのコードをご利用ください。コードはまだ使用されていません。',
  reference: 'お問い合わせ番号', refresh: '更新', signedInAs: 'サブスクリプションサービスのアカウント', privacy: '請求先情報はログインアカウントの情報とは別に管理されます。',
  steps: '利用開始まで', step1: 'ログイン', step2: 'コードを入力', step3: 'アプリに戻る',
  accountTitle: 'サブスクリプション', accountHint: '現在のサブスクリプションサービスのアカウントに紐づくプランです。', reconnect: 'アカウントを切り替える',
  allPlans: 'すべてのプラン', required: '必須', invalidProfile: '請求先情報をご確認ください。',
};

/** Every locale implements the same keys; catalog text is localized separately. */
export const messages: Record<Locale, Messages> = { en, 'zh-CN': zh, ja };

/** Query locale wins for embedded account views; preference is browser-local only. */
export function resolveLocale(value?: string | null): Locale {
  if (value?.toLowerCase().startsWith('zh')) return 'zh-CN';
  if (value?.toLowerCase().startsWith('ja')) return 'ja';
  return 'en';
}

/** Storage may be disabled in embedded or privacy-sensitive browser contexts. */
export function preference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Preference writes must never prevent the subscription workflow from working. */
export function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain in memory. */ }
}
