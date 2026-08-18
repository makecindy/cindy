/**
 * Canonical endpoint identity used only for same-provider credential reuse.
 * Paths and query strings remain significant; fragments and a trailing slash do not.
 */
export function normalizeProviderCredentialTarget(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** A key may be reused only when both runtimes authenticate to the exact same endpoint. */
export function providerCredentialTargetsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeProviderCredentialTarget(left);
  const normalizedRight = normalizeProviderCredentialTarget(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
