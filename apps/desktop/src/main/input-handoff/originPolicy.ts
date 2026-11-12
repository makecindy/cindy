import type { InputHandoffOriginWarning } from '@cindy/device-link';

/** Browsers whose page origin is the meaningful identity of what the owner types into. */
const BROWSER_BUNDLES = [
  'com.google.chrome',
  'com.apple.safari',
  'com.apple.safaritechnologypreview',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.browser',
  'company.thebrowser.browser',
  'com.vivaldi.vivaldi',
  'com.operasoftware.opera',
  'org.chromium.chromium',
  'com.kagi.kagimacos',
];

export function isBrowserBundle(bundleId: string): boolean {
  const id = bundleId.toLowerCase();
  return BROWSER_BUNDLES.some((prefix) => id === prefix || id.startsWith(`${prefix}.`));
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Display origin plus a phishing-relevant warning. Origin is shown verbatim so
 * the owner sees where the value goes; warnings only add caution, never block.
 */
export function classifyOrigin(
  rawUrl: string,
  browser: boolean,
): { origin?: string; warning?: InputHandoffOriginWarning } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {};
  }
  if (url.protocol === 'file:') return browser ? { origin: 'file://', warning: 'local-file' } : {};
  if (url.protocol === 'data:' || url.protocol === 'blob:')
    return browser ? { origin: url.protocol, warning: 'local-file' } : {};
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
  const host = url.hostname.toLowerCase();
  const origin = `${url.protocol}//${url.host}`;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === '127.0.0.1' || host === '[::1]' || host === '::1')
    return { origin, warning: 'local-host' };
  if (IPV4.test(host) || host.startsWith('['))
    return { origin, warning: 'ip-address' };
  if (host.split('.').some((label) => label.startsWith('xn--'))) return { origin, warning: 'punycode' };
  if (url.protocol === 'http:') return { origin, warning: 'insecure' };
  return { origin };
}
