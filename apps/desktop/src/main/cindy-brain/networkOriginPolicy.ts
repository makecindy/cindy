import { isPrivateOrLoopbackIpAddress, isLoopbackHost } from '@cindy/browser-control-runtime/network-address';
import type { GhostManifest } from '../../shared/ghost.js';

/** Host-only, synchronous transport check. Never resolve a hostname here. */
export function ghostNetworkTransportRejection(url: URL): string | undefined {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return undefined;
  if ((url.protocol === 'http:' || url.protocol === 'ws:') &&
      (isPrivateOrLoopbackIpAddress(url.hostname) || isLoopbackHost(url.hostname))) return undefined;
  return '明文 HTTP/WS 仅允许字面量私网、回环地址或 localhost，其他来源请使用 HTTPS/WSS';
}

/** Early feedback on new declarations; runtime checks still guard every hop. */
export function ghostDeclaredNetworkTransportRejection(manifest: GhostManifest): string | undefined {
  for (const target of manifest.network?.hosts ?? []) {
    if (!target.startsWith('http://') && !target.startsWith('ws://')) continue;
    const reason = ghostNetworkTransportRejection(new URL(target));
    if (reason) return reason;
  }
  return undefined;
}
