import { buildAgentNetMediaKey, parseAgentNetMediaKey, agentNetMediaBinding, type AgentNetMediaKey } from '@cindy/agent-net-protocol';
import { parseSharedTaskPeer, isScopedPeer } from '@cindy/device-link';
import { openEncryptedMedia, uploadEncryptedMedia } from '@cindy/agent-net-relay/client';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { agentNetClientForMediaSlot, agentNetMediaTarget, agentNetRequiresEncryption, agentNetSelectionKey, agentNetAllowsLegacy } from './agentNetRuntime.js';
import { agentNetMediaDestination, installAgentNetMediaBackend } from './agentNetMediaRouting.js';
import { agentNetSharingMediaTarget, agentNetSharingMediaClient } from './agentNetSharing.js';

export function agentNetMediaScope(): string {
  const target = agentNetMediaDestination() ?? getDeviceLinkInvokeContext()?.controllerDeviceId;
  const route = target ? agentNetSharingMediaTarget(target) ?? agentNetMediaTarget(target) : null;
  return route ? JSON.stringify([route.slot, route.api.certificate.networkId, route.recipient]) : '';
}
export function encryptedMediaUploadTarget() {
  const peer = agentNetMediaDestination() ?? getDeviceLinkInvokeContext()?.controllerDeviceId;
  const target = peer ? agentNetSharingMediaTarget(peer) ?? agentNetMediaTarget(peer) : null;
  if (!target && agentNetRequiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_MEDIA_TARGET_REQUIRED');
  return target;
}
function currentGuard(assertCaller?: () => void) {
  const scope = activeOwnerScopeKey();
  const selection = agentNetSelectionKey();
  return () => {
    assertCaller?.();
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope || selection !== agentNetSelectionKey()) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
}
export async function uploadAgentNetMedia(size: number, contentType: string, read: (offset: number, length: number) => Promise<Uint8Array>,
  options: { signal?: AbortSignal; onProgress?(bytes: number): void; assertCurrent?(): void } = {},
) {
  const route = encryptedMediaUploadTarget(); if (!route) return null;
  const task = parseSharedTaskPeer(agentNetMediaDestination() ?? getDeviceLinkInvokeContext()?.controllerDeviceId);
  const assertCurrent = currentGuard(options.assertCurrent);
  const result = await uploadEncryptedMedia(route.api, route.recipient, route.transportKey, size, read, { ...options, assertCurrent,
    ...('binding' in route && typeof route.binding === 'string' ? { binding: route.binding } : {}) });
  const grantId = 'grantId' in route && typeof route.grantId === 'string' ? route.grantId : route.api.delegation?.id;
  try {
    assertCurrent();
    return { key: buildAgentNetMediaKey({ slot: route.slot, networkId: route.api.certificate.networkId,
      ...(grantId ? { grantId } : {}),
      ...(task ? { sharedTask: { sharedTaskId: task.sharedTaskId, deviceId: route.api.identity.deviceId } } : {}),
      id: result.id, headerSha256: result.headerSha256, contentType }), size, contentType, sha256: result.sha256 };
  } catch (error) { await route.api.request('DELETE', '/media/' + result.id, undefined, { signal: AbortSignal.timeout(3000) }).catch(() => undefined); throw error; }
}
function apiFor(key: AgentNetMediaKey) {
  const caller = agentNetMediaDestination() ?? getDeviceLinkInvokeContext()?.controllerDeviceId;
  const scoped = agentNetSharingMediaClient(key.slot, key.networkId, caller, key.sharedTask?.sharedTaskId);
  if (!scoped && (key.sharedTask || isScopedPeer(caller))) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  const api = scoped ?? agentNetClientForMediaSlot(key.slot, key.networkId);
  if (!api || (api.delegation && api.delegation.id !== key.grantId)) throw new Error('AGENT_NET_MEDIA_SOURCE_UNAVAILABLE');
  return { api, ...(scoped ? { binding: agentNetMediaBinding(key.slot) } : {}) };
}
export async function openAgentNetMedia(key: string, range?: string, signal?: AbortSignal): Promise<Response> {
  const parsed = parseAgentNetMediaKey(key); if (!parsed) throw new Error('INVALID_MEDIA_KEY');
  const { api, binding } = apiFor(parsed);
  return openEncryptedMedia(api, parsed.id, parsed.headerSha256, range, parsed.contentType, { signal, assertCurrent: currentGuard(), binding });
}
export async function removeAgentNetMedia(key: string): Promise<void> {
  const parsed = parseAgentNetMediaKey(key); if (!parsed) throw new Error('INVALID_MEDIA_KEY');
  await apiFor(parsed).api.request('DELETE', '/media/' + parsed.id, undefined, { signal: AbortSignal.timeout(3000) });
}
export function installAgentNetMediaRouting(): void {
  installAgentNetMediaBackend({ guard: () => currentGuard(), available: () => !!encryptedMediaUploadTarget(), cacheScope: agentNetMediaScope,
    assertLegacyAllowed() { if (!agentNetAllowsLegacy()) throw new Error('AGENT_NET_ENCRYPTED_MEDIA_REQUIRED'); },
    upload: uploadAgentNetMedia, open: openAgentNetMedia, remove: removeAgentNetMedia });
}
