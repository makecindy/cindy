const MAX_BILLING_REDIRECT_URL_LENGTH = 2_048;

// Public provider-owned checkout hosts only. Merchant and Cindy-owned hosts do
// not belong here; adding a host changes the desktop trust boundary.
const ALLOWED_BILLING_REDIRECT_HOSTS = new Set([
  'checkout.stripe.com',
  'invoice.stripe.com',
]);
const ALLOWED_STRIPE_PORTAL_HOSTS = new Set(['billing.stripe.com']);

function isAllowedStripeUrl(value: unknown, allowedHosts: ReadonlySet<string>): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_BILLING_REDIRECT_URL_LENGTH
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      allowedHosts.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedBillingRedirectUrl(value: unknown): value is string {
  return isAllowedStripeUrl(value, ALLOWED_BILLING_REDIRECT_HOSTS);
}

export function isAllowedStripeBillingPortalUrl(value: unknown): value is string {
  return isAllowedStripeUrl(value, ALLOWED_STRIPE_PORTAL_HOSTS);
}
