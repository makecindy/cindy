import { createOutboundTransport } from '../../desktop/src/main/maker-host/outbound-fetch.js';
import { createLogger } from '../../desktop/src/main/logger.js';
/** Headless network adapter: explicit service-account proxy environment, with
 * the same HTTP CONNECT / SOCKS implementation used by desktop. There is no
 * graphical session from which a system PAC policy could be read. */
import { createEnvOutboundProxyResolver, isLoopbackHostname, parseOutboundProxyUrl,
  Socks5HttpAgent, Socks5HttpsAgent, TunnelingHttpsAgent } from '@cindy/anthropic-compat-proxy';
const resolveProxy = createEnvOutboundProxyResolver();
export const resolveHostOutboundProxy = resolveProxy;
export async function createHostWebSocketAgent(url) {
  const upstream = new URL(url);
  upstream.protocol = upstream.protocol === 'wss:' ? 'https:' : upstream.protocol === 'ws:' ? 'http:' : upstream.protocol;
  if (isLoopbackHostname(upstream.hostname)) return undefined;
  const raw = await resolveProxy(upstream.href);
  if (!raw) return undefined;
  const proxy = parseOutboundProxyUrl(raw);
  if (!proxy) throw new Error('Unsupported Host proxy configuration');
  if (proxy.kind === 'socks5') return upstream.protocol === 'https:' ? new Socks5HttpsAgent(proxy) : new Socks5HttpAgent(proxy);
  if (upstream.protocol !== 'https:') throw new Error('HTTP proxy requires a secure relay endpoint');
  return new TunnelingHttpsAgent(proxy);
}

// Plugin, model and auth traffic share the same DNS pinning, redirect and proxy
// machinery as Desktop. Headless only changes how proxy settings are obtained.
export const hostOutbound = createOutboundTransport(resolveProxy, createLogger('host-outbound'));
