import { createHash } from 'node:crypto';

/** Host-owned routing receipt; contains no URL, credential or request content. */
export interface PiCacheCompatibility {
  providerId: string;
  modelId: string;
  wireModelId: string;
  routeKey: string;
  applied: boolean;
}

/** Include paths and query routing in the digest. Never persist the source URL. */
export function piCacheRouteKey(endpoint: string, api: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return undefined;
    url.hash = '';
    return createHash('sha256').update(JSON.stringify(['pi-cache-v1', api, url.href])).digest('hex');
  } catch {
    return undefined;
  }
}
