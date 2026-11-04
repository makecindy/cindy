import { httpsUrl, PluginProtocolError, string } from './internal/parse.js';

/** Host-only opt-in. Packaged clients must never supply this development origin. */
export interface PluginObjectUrlOptions {
  developmentObjectOrigin?: string;
}

/** Delivery objects default to HTTPS; only the exact local storage adapter may use HTTP. */
export function parsePluginObjectUrl(
  value: unknown,
  path: string,
  options?: PluginObjectUrlOptions,
): string {
  const text = string(value, path, 8_192);
  let url: URL;
  try { url = new URL(text); } catch { throw new PluginProtocolError(`${path} 必须是 HTTPS URL`); }
  if (url.username || url.password) throw new PluginProtocolError(`${path} 不允许 URL 用户信息`);
  if (url.protocol === 'https:') return httpsUrl(text, path);
  if (options?.developmentObjectOrigin) {
    let origin: URL | undefined;
    try { origin = new URL(options.developmentObjectOrigin); } catch { /* Reject invalid policy. */ }
    if (origin && origin.origin === options.developmentObjectOrigin &&
        origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
        !origin.username && !origin.password && url.protocol === 'http:' &&
        url.origin === origin.origin && url.pathname === '/dev-local/object' && !url.hash) return text;
  }
  throw new PluginProtocolError(`${path} 必须是 HTTPS URL`);
}
