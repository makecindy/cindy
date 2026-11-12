/** Only a native address-field submission may opt into browsing an external site. */
export function normalizeBrowserAddress(input: string): string | null {
  const value = input.trim();
  if (!value || /[\s\\]/.test(value)) return null;
  const hostWithPort = /^(?:localhost|[^/?#:@]+\.[^/?#:@]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/i.test(value);
  const explicitScheme = !hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(value);
  try {
    const url = new URL(explicitScheme ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (!explicitScheme && !url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch { return null; }
}

export function allowWebsiteNavigation(value: string): boolean {
  return /^https?:\/\//i.test(value) && normalizeBrowserAddress(value) !== null;
}
