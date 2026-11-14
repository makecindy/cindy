import { isPrivateOrLoopbackIpAddress, isLoopbackHost, isCloudMetadataIpAddress, normalizeIpAddress } from '@cindy/browser-control-runtime/network-address';
import type { GhostManifest } from '../../shared/ghost.js';

function cloudMetadataRejection(host: string): string | undefined {
  // The shared policy classifies 169.254/16 as link-local; exclude only this
  // endpoint, preserving the remaining link-local range and Browser policy.
  if (normalizeIpAddress(host) === '169.254.169.254' || isCloudMetadataIpAddress(host))
    return '插件网络禁止访问云元数据地址';
  return undefined;
}

/** Host-only, synchronous transport check. Never resolve a hostname here. */
export function ghostNetworkTransportRejection(url: URL): string | undefined {
  const metadataError = cloudMetadataRejection(url.hostname);
  if (metadataError) return metadataError;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return undefined;
  if ((url.protocol === 'http:' || url.protocol === 'ws:') &&
      (isPrivateOrLoopbackIpAddress(url.hostname) || isLoopbackHost(url.hostname))) return undefined;
  return '明文 HTTP/WS 仅允许字面量私网、回环地址或 localhost，其他来源请使用 HTTPS/WSS';
}

/** Early feedback on new declarations; runtime checks still guard every hop. */
export function ghostDeclaredNetworkTransportRejection(manifest: GhostManifest): string | undefined {
  for (const target of manifest.network?.hosts ?? []) {
    if (!target.includes('://')) continue;
    const reason = ghostNetworkTransportRejection(new URL(target));
    if (reason) return reason;
  }
  return undefined;
}
