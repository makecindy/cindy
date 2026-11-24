import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  forgetUnverifiedStickySessionOrigin,
  getLastVerifiedSessionDeviceId,
  getStickySessionDeviceId,
} from '@/features/device-link/stickySessionOrigin';
import { extractIpcError } from '@/utils/ipcError';
import type { Session } from './ccAgent.types';
import { getSessionRouteOwnerId, isOrcaWorkerSession, resolveSessionRoute, standardSessionRoute } from './orcaSessionIdentity';

interface NavigationTarget {
  sessionId: string;
  deviceHint?: string | null;
  selfDeviceId?: string | null;
  isCurrent: () => boolean;
}

const inFlight = new Map<string, Promise<Session | null>>();

function readSession(sessionId: string, deviceId: string | null): Promise<Session | null> {
  const { dataOwnerId, generation } = getDataOwnerGeneration();
  const key = JSON.stringify([dataOwnerId, generation, deviceId, sessionId]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  // The local IPC is deliberately independent of both the remote origin index
  // and sessionService's session-id-only in-flight cache.
  const request = (async () => {
    try {
      const value = deviceId
        ? await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [sessionId]) as Session | null
        : await window.electronAPI.localDb.sessions.get(sessionId);
      return value?.id === sessionId && value.status !== 'deleted' ? value : null;
    } catch (error) {
      if (extractIpcError(error)?.code === 'NOT_FOUND') return null;
      throw error;
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

function assertNoRemoteConflict(sessionId: string, deviceId: string | null): void {
  const pinned = remoteProjectsStore.getVerifiedPinnedSessionDeviceId(sessionId);
  const sticky = getLastVerifiedSessionDeviceId(sessionId);
  const preview = remoteProjectsStore.getCreationPreview(sessionId)?.row.deviceLinkDeviceId;
  if ((pinned && pinned !== deviceId) || (sticky && sticky !== deviceId) || (preview && preview !== deviceId)
    || remoteProjectsStore.getMergedRemoteSessions().some((row) =>
      row.id === sessionId && row.status !== 'deleted' && row.deviceLinkDeviceId
        && row.deviceLinkDeviceId !== deviceId)) {
    throw new Error('[PERMISSION_DENIED] Conflicting task origins');
  }
}

function mirroredSession(deviceId: string, sessionId: string): Session | undefined {
  return remoteProjectsStore.getDeviceSessions(deviceId).find((row) =>
    row.id === sessionId && row.status !== 'deleted');
}

async function prepareSessionOrigin(
  target: NavigationTarget,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return null;
  const { sessionId, deviceHint } = target;
  const candidate = deviceHint ?? getStickySessionDeviceId(sessionId);
  let deviceId = candidate && candidate !== 'local' ? candidate : null;
  if (deviceId) {
    const selfDeviceId = target.selfDeviceId ?? await window.electronAPI.getDeviceId();
    if (!isCurrent()) return null;
    if (deviceId === selfDeviceId) deviceId = null;
  }

  const local = !deviceId || !deviceHint ? await readSession(sessionId, null) : undefined;
  if (!isCurrent()) return null;
  if (local) deviceId = null;
  assertNoRemoteConflict(sessionId, deviceId);

  const check = deviceId ? remoteProjectsStore.captureSessionRead(deviceId, sessionId) : null;
  const cached = deviceId ? mirroredSession(deviceId, sessionId) : undefined;
  const read = deviceId ? cached ?? await readSession(sessionId, deviceId) : local;
  if (!isCurrent()) return null;
  const session = deviceId && check && !check() ? mirroredSession(deviceId, sessionId) : read;
  if (!session) throw new Error('[NOT_FOUND] Task does not exist');
  if (deviceId && local === undefined && await readSession(sessionId, null)) {
    throw new Error('[PERMISSION_DENIED] Conflicting task origins');
  }
  if (!isCurrent()) return null;

  const validate = () => {
    assertNoRemoteConflict(sessionId, deviceId);
    if (deviceId && check && !check()) {
      const latest = mirroredSession(deviceId, sessionId);
      // Activity and other metadata can arrive while this entry is pending.
      // Its route only remains valid if the fields that select it still match.
      if (!latest || (latest.orcaRole ?? null) !== (session.orcaRole ?? null)
        || (latest.source ?? null) !== (session.source ?? null)) {
        throw new Error('Remote task read invalidated');
      }
    }
  };
  return {
    session,
    deviceId,
    validate,
    commit: () => {
      if (deviceId) {
        remoteProjectsStore.pinSessionOrigin(deviceId, sessionId);
        if (!cached && check?.()) {
          remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '',
            [check.mergeActivity(session)]);
        }
      } else if (getStickySessionDeviceId(sessionId)) {
        forgetUnverifiedStickySessionOrigin(sessionId);
        remoteProjectsStore.clearUnverifiedSessionOrigin(sessionId);
      }
    },
  };
}

/** Verify a task's route before a session-id keyed reader or editor mounts. */
export async function restoreSessionNavigationOrigin(target: NavigationTarget): Promise<boolean> {
  const owner = getDataOwnerGeneration();
  const isCurrent = () => target.isCurrent() && isDataOwnerGenerationCurrent(owner);
  const entry = await prepareSessionOrigin(target, isCurrent);
  if (!entry || !isCurrent()) return false;
  entry.validate();
  entry.commit();
  return true;
}

/** Resolve a link without exposing any candidate as a shared transport origin. */
export async function resolveSessionNavigationRoute(
  target: NavigationTarget,
  { exactTask = false } = {},
): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  const isCurrent = () => target.isCurrent() && isDataOwnerGenerationCurrent(owner);
  const entry = await prepareSessionOrigin(target, isCurrent);
  if (!entry || !isCurrent()) return null;
  const route = exactTask && !isOrcaWorkerSession(entry.session)
    ? standardSessionRoute(target.sessionId)
    : await resolveSessionRoute(target.sessionId, entry.session, {
      remote: Boolean(entry.deviceId),
      deviceId: entry.deviceId,
    });
  if (!isCurrent()) return null;
  if (route === '/cc-agent') return route;

  // A Worker link may mount its Lead instead. Verify the Lead on the same
  // host, and publish neither origin if the canonical target is ambiguous.
  const routeOwner = getSessionRouteOwnerId(route);
  const lead = routeOwner && routeOwner !== target.sessionId
    ? await prepareSessionOrigin({ ...target, sessionId: routeOwner, deviceHint: entry.deviceId ?? 'local' }, isCurrent)
    : null;
  if (!isCurrent()) return null;
  entry.validate();
  lead?.validate();
  entry.commit();
  lead?.commit();
  return route;
}
