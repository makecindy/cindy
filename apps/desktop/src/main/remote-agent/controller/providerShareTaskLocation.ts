import { providerShareHostPeer, type RemoteAgentKind } from '@cindy/device-link';

import { getRemoteLinkCloseEpoch, openRemoteLink, remoteBackgroundInvoke } from '../../device-link/index.js';
import { isCrossRegionProviderShareTarget, renewCrossRegionProviderShareLink } from '../../device-link/providerShareCrossRegion.js';
import { parseProviderShareAgentDeviceId } from '../../device-link/providerShareGuest.js';
import { RemoteAgentRunClient, remoteAgentInvoker } from './runClient.js';

type SharedTaskAuthorization = { target: string; direct: boolean; generation?: string; leaseDeadline?: number };
const GRANT_ID = /^[0-9a-f-]{36}$/;

/** O reports remaining time, so G never compares clocks on different computers. Missing means legacy O. */
export function sharedTaskLeaseDeadline(value: unknown, requestedAt: number): number | undefined {
  const duration = value && typeof value === 'object' ? (value as { leaseDurationMs?: unknown }).leaseDurationMs : undefined;
  if (duration === undefined) return undefined;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 30 * 60_000) {
    throw new Error('[REMOTE_AGENT_INVALID] shared task authorization has an invalid lifetime');
  }
  const deadline = requestedAt + duration;
  if (deadline <= performance.now()) throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared task authorization has expired');
  return deadline;
}

/** Release only this task's allocation generation; a source/sibling lease is never selected. */
export async function releaseSharedTaskAuthorization(ownerRoute: string, sessionId: string, generation?: string): Promise<void> {
  if (generation) await remoteAgentInvoker(ownerRoute, remoteBackgroundInvoke)([{
    op: 'direct-release', sessionId, generation,
  }]);
}

/** Pinned allocation: neither a null response nor another executor can accept existing native history. */
export async function authorizeSharedTaskExecutor(
  ownerRoute: string, sessionId: string, agentKind: RemoteAgentKind, model: string,
  deviceId: string, releaseOnFailure = false, signal?: AbortSignal,
): Promise<SharedTaskAuthorization> {
  signal?.throwIfAborted();
  const shareId = parseProviderShareAgentDeviceId(ownerRoute);
  if (!shareId) throw new Error('[REMOTE_AGENT_INVALID] a shared task owner is required');
  const target = providerShareHostPeer(shareId, deviceId);
  const closeEpoch = getRemoteLinkCloseEpoch(target);
  const requestedAt = performance.now();
  const value = await remoteAgentInvoker(ownerRoute, remoteBackgroundInvoke)([{
    op: 'allocate', sessionId, agentKind, model, preferredExecutorDeviceId: deviceId,
  }]).catch(error => { signal?.throwIfAborted(); throw error; });
  const row = value && typeof value === 'object' ? value as { deviceId?: unknown; generation?: unknown } : null;
  const generation = typeof row?.generation === 'string' && GRANT_ID.test(row.generation) ? row.generation : undefined;
  try {
    signal?.throwIfAborted();
    if (row?.deviceId !== deviceId) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] the computer holding this shared task is unavailable');
    }
    const requireCurrentLink = (): void => {
      signal?.throwIfAborted();
      if (getRemoteLinkCloseEpoch(target) !== closeEpoch) {
        throw new Error('[REMOTE_AGENT_UNAVAILABLE] shared executor link was closed during authorization');
      }
    };
    requireCurrentLink();
    // A restarted M can lose its transport while G still considers the peer
    // ready. Reconfirm only this peer after its fresh grant, before native IDs
    // or task contents are sent. Preserve the share's existing regional relay.
    if (isCrossRegionProviderShareTarget(target)) await renewCrossRegionProviderShareLink(target);
    else await openRemoteLink(target);
    requireCurrentLink();
    const caps = await RemoteAgentRunClient.caps(remoteAgentInvoker(target, remoteBackgroundInvoke));
    requireCurrentLink();
    if (!caps.directGuestExecution || !caps.agents.some(agent => agent.kind === agentKind && agent.available)) {
      throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] the computer holding this shared task cannot accept it');
    }
    const leaseDeadline = sharedTaskLeaseDeadline(value, requestedAt);
    return { target, direct: true, ...(generation ? { generation } : {}), ...(leaseDeadline !== undefined ? { leaseDeadline } : {}) };
  } catch (error) {
    // Terminal cancellation owns only this attempt's returned generation, including
    // a late allocation/caps failure. Never wait for the expired route to release it.
    if (signal?.aborted) {
      void releaseSharedTaskAuthorization(ownerRoute, sessionId, generation).catch(() => undefined);
      signal.throwIfAborted();
    }
    // Only a newly authorized child opts into other failure cleanup; source history can still be live.
    if (releaseOnFailure) await releaseSharedTaskAuthorization(ownerRoute, sessionId, generation).catch(() => undefined);
    throw error;
  }
}

/** Location is durable affinity, never authorization. Every historical use obtains a fresh M/server lease. */
export async function authorizeSharedTaskHistory(
  agentDeviceId: string, sessionId: string, agentKind: RemoteAgentKind, model: string, signal?: AbortSignal,
): Promise<SharedTaskAuthorization> {
  signal?.throwIfAborted();
  if (!parseProviderShareAgentDeviceId(agentDeviceId)) return { target: agentDeviceId, direct: false };
  let location: unknown;
  try {
    location = await remoteAgentInvoker(agentDeviceId, remoteBackgroundInvoke)([{ op: 'direct-locate', sessionId }]);
    signal?.throwIfAborted();
  } catch (error) {
    // An aborted lookup is never the legacy-server fallback, whatever its late error.
    signal?.throwIfAborted();
    const transportCode = (error as { code?: unknown })?.code;
    // Desktop dispatch wraps explicit domain codes in IPC_ERROR. A transport
    // timeout/denial must still outrank any message text and must never fall back.
    const code = transportCode === undefined || transportCode === 'IPC_ERROR'
      ? (error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined)
      : transportCode;
    if (code === 'REMOTE_AGENT_INVALID' || code === 'REMOTE_AGENT_PEER_TOO_OLD' || code === 'PEER_TOO_OLD') {
      return { target: agentDeviceId, direct: false };
    }
    throw error;
  }
  if (location === null) return { target: agentDeviceId, direct: false };
  const deviceId = location && typeof location === 'object' ? (location as { deviceId?: unknown }).deviceId : undefined;
  if (typeof deviceId !== 'string') throw new Error('[REMOTE_AGENT_INVALID] invalid shared task location');
  return authorizeSharedTaskExecutor(agentDeviceId, sessionId, agentKind, model, deviceId, false, signal);
}

const liveTargets = new Map<string, { target: string; authorized(): boolean }>();

/** A live handle owns this entry; late close cannot clear a replacement handle. */
export function trackLiveSharedTaskTarget(sessionId: string, ownerRoute: string, target: string, authorized: () => boolean): () => void {
  const key = JSON.stringify([ownerRoute, sessionId]);
  const entry = { target, authorized };
  liveTargets.set(key, entry);
  return () => { if (liveTargets.get(key) === entry) liveTargets.delete(key); };
}

/** Only an open, unexpired handle can reuse its current lease for live artifact delivery. */
export function liveSharedTaskTarget(sessionId: string, ownerRoute: string): string | null {
  const entry = liveTargets.get(JSON.stringify([ownerRoute, sessionId]));
  return entry?.authorized() ? entry.target : null;
}
