import type { McpProvider } from '@cindy/maker-core';

/** Desktop-owned loopback hosts. Remote Pi's loopback is a different machine. */
export function isDesktopLoopbackMcpUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]';
}

/** Pi direct MCP URLs must match the bridge's HTTPS / explicit loopback boundary. */
export function isAllowedRemoteMcpUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isDesktopLoopbackMcpUrl(url);
}

/**
 * Registered user MCPs are HTTP/SSE configs, never in-process SDK servers.
 * Pi consumes their Codex serialization; a Claude SSE config cannot be its SDK fallback.
 * Inspect only the serialized route, without starting a bridge or returning secrets.
 * SSH Pi connects to custom HTTP MCPs directly (`s.remote` is not tunneled), so
 * desktop loopback URLs are unavailable whenever `remoteHostId` is set.
 */
export function isPiCustomMcpProviderAvailable(
  provider: McpProvider,
  opts?: { remoteHostId?: string | null },
): boolean {
  try {
    const config = provider.toCodexMcpConfig?.({ agentKind: 'pi', workingDir: '', vendorOptions: {} });
    if (config?.type !== 'http') return false;
    const url = new URL(config.url);
    if (!isAllowedRemoteMcpUrl(url)) return false;
    return !(opts?.remoteHostId && isDesktopLoopbackMcpUrl(url));
  } catch {
    return false;
  }
}
