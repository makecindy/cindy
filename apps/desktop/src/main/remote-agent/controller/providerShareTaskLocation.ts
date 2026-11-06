import { parseProviderSharePeer, providerShareHostPeer, type RemoteAgentKind } from '@cindy/device-link';

import { getRemoteLinkCloseEpoch, openRemoteLink, remoteBackgroundInvoke } from '../../device-link/index.js';
import { isCrossRegionProviderShareTarget, renewCrossRegionProviderShareLink } from '../../device-link/providerShareCrossRegion.js';
import { parseProviderShareAgentDeviceId } from '../../device-link/providerShareGuest.js';
import { RemoteAgentRunClient, remoteAgentInvoker } from './runClient.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { getClientEndpoint } from '../../clientEndpointsService.js';
import { findReceivedShare, providerShareAccessEpoch } from '../../device-link/providerShareGuest.js';
import { probeSharedTask, sharedTaskFailureReason, sharedTaskRecoveryError, sharedTaskRecoveryReason } from '../../../shared/sharedTaskRecovery.js';

type SharedTaskAuthorization = { target: string; direct: boolean; reused?: boolean; generation?: string; leaseDeadline?: number; wallDeadline?: number; authorizedUntil?: number; renewAt?: number };
const GRANT_ID = /^[0-9a-f-]{36}$/;
type RetainedTask = SharedTaskAuthorization & { agentKind: RemoteAgentKind; model: string; current(): boolean };
const retainedTasks = new Map<string, RetainedTask>();
const taskKey = (ownerRoute: string, sessionId: string) => JSON.stringify([ownerRoute, sessionId]);

/** Process-local affinity + an existing task grant. Restart, expiry or explicit link close cannot create a grant. */
export function rememberSharedTaskAuthorization(ownerRoute: string, sessionId: string, agentKind: RemoteAgentKind,
  model: string, grant: SharedTaskAuthorization): void {
  if (!grant.direct || grant.leaseDeadline === undefined || grant.wallDeadline === undefined || grant.authorizedUntil === undefined) return;
  const wallUntil = Math.min(grant.authorizedUntil, grant.wallDeadline), monoUntil = grant.leaseDeadline;
  const owner = activeOwnerScopeKey(), endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const closeEpoch = getRemoteLinkCloseEpoch(grant.target);
  const ownerEpoch = getRemoteLinkCloseEpoch(ownerRoute);
  const shareId = parseProviderShareAgentDeviceId(ownerRoute);
  const share = shareId ? findReceivedShare(shareId) : null;
  if (!share || share.status !== 'active') return;
  const accessEpoch = providerShareAccessEpoch(shareId!);
  const ownerTarget = share.hostDeviceId ? providerShareHostPeer(shareId!, share.hostDeviceId) : ownerRoute;
  const hostEpoch = getRemoteLinkCloseEpoch(ownerTarget);
  const identity = JSON.stringify([share.memberId, share.hostDeviceId, share.providerId]);
  const key = taskKey(ownerRoute, sessionId);
  const current = () => {
    if (Date.now() >= wallUntil || performance.now() >= monoUntil) {
      if (retainedTasks.get(key) === entry) retainedTasks.delete(key);
      return false;
    }
    const now = shareId ? findReceivedShare(shareId) : null;
    return retainedTasks.get(key) === entry && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner
      && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint
      && getRemoteLinkCloseEpoch(grant.target) === closeEpoch && getRemoteLinkCloseEpoch(ownerRoute) === ownerEpoch
      && getRemoteLinkCloseEpoch(ownerTarget) === hostEpoch && providerShareAccessEpoch(shareId!) === accessEpoch
      && now?.status === 'active' && JSON.stringify([now.memberId, now.hostDeviceId, now.providerId]) === identity
      && Date.now() < wallUntil && performance.now() < monoUntil;
  };
  const entry = { ...grant, agentKind, model, current };
  for (const [key, entry] of retainedTasks) if (!entry.current()) retainedTasks.delete(key);
  if (retainedTasks.size >= 512) retainedTasks.delete(retainedTasks.keys().next().value!);
  retainedTasks.set(key, entry);
}

export function forgetSharedTaskAuthorization(ownerRoute: string, sessionId: string, expectedGeneration?: string): void {
  if (expectedGeneration !== undefined && retainedTasks.get(taskKey(ownerRoute, sessionId))?.generation !== expectedGeneration) return;
  retainedTasks.delete(taskKey(ownerRoute, sessionId));
}

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
  const retained = retainedTasks.get(taskKey(ownerRoute, sessionId));
  if (retained?.generation === generation) forgetSharedTaskAuthorization(ownerRoute, sessionId);
  if (generation) await remoteAgentInvoker(ownerRoute, remoteBackgroundInvoke)([{
    op: 'direct-release', sessionId, generation,
  }]);
}

/** Pinned allocation: neither a null response nor another executor can accept existing native history. */
export async function authorizeSharedTaskExecutor(
  ownerRoute: string, sessionId: string, agentKind: RemoteAgentKind, model: string,
  deviceId: string, releaseOnFailure = false, signal?: AbortSignal,
  retainedHistory?: SharedTaskAuthorization,
): Promise<SharedTaskAuthorization> {
  signal?.throwIfAborted();
  const shareId = parseProviderShareAgentDeviceId(ownerRoute);
  if (!shareId) throw new Error('[REMOTE_AGENT_INVALID] a shared task owner is required');
  const target = providerShareHostPeer(shareId, deviceId);
  const retainedWindow = retainedHistory ? retainedTasks.get(taskKey(ownerRoute, sessionId)) : undefined;
  if (retainedHistory && (!retainedWindow || !retainedWindow.current()
    || retainedWindow.target !== target || retainedWindow.agentKind !== agentKind || retainedWindow.model !== model
    || (['generation', 'leaseDeadline', 'wallDeadline', 'authorizedUntil', 'renewAt'] as const)
      .some(key => retainedHistory[key] !== retainedWindow[key]))) {
    throw sharedTaskRecoveryError('authorization', 'history');
  }
  const closeEpoch = getRemoteLinkCloseEpoch(target);
  const owner = activeOwnerScopeKey(), endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const share = findReceivedShare(shareId);
  const accessEpoch = share?.status === 'active' ? providerShareAccessEpoch(shareId) : undefined;
  const requestedAt = performance.now();
  const requestedWall = Date.now();
  const value = await remoteAgentInvoker(ownerRoute, remoteBackgroundInvoke)([{
    op: 'allocate', sessionId, agentKind, model, preferredExecutorDeviceId: deviceId,
  }]).catch(error => {
    signal?.throwIfAborted();
    if (error instanceof Error && sharedTaskRecoveryReason(error.message)) throw error;
    throw sharedTaskRecoveryError('allocation', sharedTaskFailureReason(error), error);
  });
  const row = value && typeof value === 'object' ? value as { deviceId?: unknown; generation?: unknown } : null;
  const generation = typeof row?.generation === 'string' && GRANT_ID.test(row.generation) ? row.generation : undefined;
  try {
    signal?.throwIfAborted();
    if (row?.deviceId !== deviceId) {
      // A legacy O returns null without a reason. Never invent an offline verdict.
      throw sharedTaskRecoveryError('allocation', row?.deviceId ? 'history' : 'unknown');
    }
    const requireCurrentLink = (): void => {
      signal?.throwIfAborted();
      if (retainedWindow && !retainedWindow.current()) {
        throw sharedTaskRecoveryError('authorization', 'history');
      }
      if (getRemoteLinkCloseEpoch(target) !== closeEpoch) {
        throw sharedTaskRecoveryError('executor', 'relay');
      }
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner
        || getClientEndpoint('deviceLinkApiBaseUrl') !== endpoint
        || (accessEpoch !== undefined && (findReceivedShare(shareId)?.status !== 'active'
          || providerShareAccessEpoch(shareId) !== accessEpoch))) {
        throw sharedTaskRecoveryError('authorization', 'denied');
      }
    };
    requireCurrentLink();
    // A restarted M can lose its transport while G still considers the peer
    // ready. Reconfirm only this peer after its fresh grant, before native IDs
    // or task contents are sent. Preserve the share's existing regional relay.
    await probeSharedTask('executor', async () => {
      if (isCrossRegionProviderShareTarget(target)) await renewCrossRegionProviderShareLink(target);
      else await openRemoteLink(target);
    }, requireCurrentLink);
    requireCurrentLink();
    const caps = await probeSharedTask('capability', () => RemoteAgentRunClient.caps(remoteAgentInvoker(target, remoteBackgroundInvoke)), requireCurrentLink);
    requireCurrentLink();
    if (!caps.directGuestExecution || !caps.agents.some(agent => agent.kind === agentKind && agent.available)) {
      throw sharedTaskRecoveryError('capability', 'unsupported');
    }
    const leaseDeadline = sharedTaskLeaseDeadline(value, requestedAt);
    const grant: SharedTaskAuthorization = { target, direct: true, ...(generation ? { generation } : {}),
      ...(leaseDeadline !== undefined ? { leaseDeadline, wallDeadline: requestedWall + leaseDeadline - requestedAt,
        renewAt: requestedWall + Math.min(20 * 60_000, (leaseDeadline - requestedAt) * 2 / 3),
        authorizedUntil: requestedWall + Math.min(29 * 60_000, leaseDeadline - requestedAt) } : {}) };
    if (retainedWindow) {
      // A failed probe is not a renewal. Even a successful O/M replacement
      // remains bounded by this history's original wall/monotonic window.
      for (const key of ['leaseDeadline', 'wallDeadline', 'authorizedUntil', 'renewAt'] as const) {
        const previous = retainedWindow[key];
        if (previous !== undefined) grant[key] = Math.min(grant[key] ?? previous, previous);
      }
      grant.reused = true;
    }
    rememberSharedTaskAuthorization(ownerRoute, sessionId, agentKind, model, grant);
    return grant;
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

/** Durable location is not authorization. Reuse only this process's unexpired original grant, with M's live check. */
export async function authorizeSharedTaskHistory(
  agentDeviceId: string, sessionId: string, agentKind: RemoteAgentKind, model: string, signal?: AbortSignal,
): Promise<SharedTaskAuthorization> {
  signal?.throwIfAborted();
  if (!parseProviderShareAgentDeviceId(agentDeviceId)) return { target: agentDeviceId, direct: false };
  const retained = retainedTasks.get(taskKey(agentDeviceId, sessionId));
  if (retained?.current() && retained.agentKind === agentKind && retained.model === model) {
    try {
      const caps = await RemoteAgentRunClient.caps(remoteAgentInvoker(retained.target, remoteBackgroundInvoke));
      signal?.throwIfAborted();
      if (!retained.current()) throw sharedTaskRecoveryError('authorization', 'history');
      if (!caps.directGuestExecution || !caps.agents.some(agent => agent.kind === agentKind && agent.available)) {
        throw sharedTaskRecoveryError('capability', 'unsupported');
      }
      return { target: retained.target, direct: true, reused: true, generation: retained.generation,
        leaseDeadline: retained.leaseDeadline, wallDeadline: retained.wallDeadline,
        authorizedUntil: retained.authorizedUntil, renewAt: retained.renewAt };
    } catch (error) {
      signal?.throwIfAborted();
      // After an M restart the scoped handshake can fail before caps/open
      // can report a missing task grant. Ask O for a real replacement, pinned
      // to the same M, then require M's fresh handshake and caps. A timeout
      // alone grants nothing; explicit denials and offline verdicts propagate.
      const code = (error as { code?: unknown })?.code;
      const peer = parseProviderSharePeer(retained.target);
      if (!retained.current() || !peer || peer.role !== 'host'
        || !['TIMEOUT', 'INVOKE_TIMEOUT', 'DEVICE_UNRESPONSIVE'].includes(String(code))) {
        if (error instanceof Error && sharedTaskRecoveryReason(error.message)) throw error;
        throw sharedTaskRecoveryError('capability', sharedTaskFailureReason(error), error);
      }
      return authorizeSharedTaskExecutor(agentDeviceId, sessionId, agentKind, model, peer.deviceId, false, signal, retained);
    }
  }
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
    if (error instanceof Error && sharedTaskRecoveryReason(error.message)) throw error;
    throw sharedTaskRecoveryError('owner', sharedTaskFailureReason(error), error);
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
