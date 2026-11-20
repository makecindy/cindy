import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripTrailingSlashes } from '@cindy/agent-net-protocol';
import type { RelayOptions } from './server.js';
export interface NotificationBridgeConfig { url: string; secretFile: string; }
/** Shared Node-host configuration for embedded and CLI relays. The secret is
 * read from an operator file, never from a relay request or a public snapshot. */
export function readNotificationBridgeConfig(env: NodeJS.ProcessEnv = process.env): NotificationBridgeConfig | undefined {
  const url = env.AGENT_NET_NOTIFICATION_URL?.trim(), secretFile = env.AGENT_NET_NOTIFICATION_SECRET_FILE?.trim();
  if (!url && !secretFile) return undefined;
  if (!url || !secretFile) throw new Error('NOTIFICATION_BRIDGE_CONFIG_REQUIRED');
  let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('INVALID_NOTIFICATION_BRIDGE_URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('INVALID_NOTIFICATION_BRIDGE_URL');
  if (!path.isAbsolute(secretFile)) throw new Error('NOTIFICATION_SECRET_FILE_MUST_BE_ABSOLUTE');
  return { url: stripTrailingSlashes(url), secretFile };
}
export async function createNotificationBridge(config: NotificationBridgeConfig | undefined,
  options: { fetch?: typeof fetch; readSecret?: (file: string) => Promise<string> } = {}): Promise<RelayOptions['notify']> {
  if (!config) return undefined;
  // Validate injected configuration just as strictly as environment input.
  config = readNotificationBridgeConfig({ AGENT_NET_NOTIFICATION_URL: config.url, AGENT_NET_NOTIFICATION_SECRET_FILE: config.secretFile })!;
  let secret: string;
  try { secret = (await (options.readSecret ?? (async file => {
    if ((await stat(file)).size > 4096) throw new Error('INVALID_NOTIFICATION_SECRET');
    return readFile(file, 'utf8');
  }))(config.secretFile)).trim(); }
  catch { throw new Error('INVALID_NOTIFICATION_SECRET'); }
  if (secret.length < 32 || secret.length > 4096 || /[\r\n]/.test(secret)) throw new Error('INVALID_NOTIFICATION_SECRET');
  const request = options.fetch ?? fetch, endpoint = config.url;
  return async notification => {
    const response = await request(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(notification) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('NOTIFICATION_DELIVERY_FAILED');
  };
}
