const MAX_BILLING_REDIRECT_URL_LENGTH = 2_048;

// Public provider-owned checkout hosts only. Merchant and Cindy-owned hosts do
// not belong here; adding a host changes the desktop trust boundary.
const ALLOWED_BILLING_REDIRECT_HOSTS = new Set([
  'checkout.stripe.com',
  'invoice.stripe.com',
]);
const ALLOWED_STRIPE_PORTAL_HOSTS = new Set(['billing.stripe.com']);

function parseHttpsBillingUrl(value: unknown): URL | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_BILLING_REDIRECT_URL_LENGTH
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === ''
    ) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAllowedBillingRedirectUrl(value: unknown): value is string {
  const url = parseHttpsBillingUrl(value);
  if (!url) return false;
  if (ALLOWED_BILLING_REDIRECT_HOSTS.has(url.hostname)) return true;
  if (url.hostname === 'g.alipayplus.com') {
    const cn = url.pathname === '/page/aplus-linker/acwallet/qrcode.html';
    const hk = url.pathname === '/page/aplus-linker/acwallet/authorization.html';
    if ((!cn && !hk) || url.searchParams.get('source') !== 'AlipayConnect') return false;
    if (cn && url.searchParams.get('url') !== 'alipayconnect://platformapi/acwallet/signContract') return false;
    try {
      const data = JSON.parse(url.searchParams.get('bizContent') ?? 'null');
      const returnUrl = parseHttpsBillingUrl(data?.authRedirectUrl);
      return data?.customerBelongsTo === (cn ? 'ALIPAY_CN' : 'ALIPAY_HK') &&
        returnUrl?.hostname === 'g.alipayplus.com' &&
        returnUrl.pathname === '/page/ac-auth-payment/result/mobile/index.html';
    } catch {
      return false;
    }
  }
  return url.hostname === 'checkout.antom.com' &&
    /^\/easysafepay\/\d+\.\d+\.\d+\/pages\/api-portal\/index\.html$/.test(url.pathname) &&
    url.searchParams.has('sessionData');
}

export function isAllowedStripeBillingPortalUrl(value: unknown): value is string {
  const url = parseHttpsBillingUrl(value);
  return url !== null && ALLOWED_STRIPE_PORTAL_HOSTS.has(url.hostname);
}
