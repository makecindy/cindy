import { isBlockedHostnameOrIp } from './_generated/leaf/src/infra/net/ssrf.js';

/**
 * Resource downloads are host-side writes and must not become a local-network
 * fetch primitive for page content.
 */
export function isPublicHttpResourceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && !isBlockedHostnameOrIp(parsed.hostname)
    );
  } catch {
    return false;
  }
}
