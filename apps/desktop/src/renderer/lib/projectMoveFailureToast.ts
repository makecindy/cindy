import { i18n } from '@/i18n';
import { getDataOwnerGeneration, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from './remoteDataOwnerPushFence';
import { toast } from './toast';

/** Background moves are silent except for a terminal failure, once per request and owner. */
export function installProjectMoveFailureToastListener(): () => void {
  let owner = getDataOwnerGeneration();
  const seen = new Set<string>();
  const report = (deviceId: string, sessionId: string, patch: unknown) => {
    const current = getDataOwnerGeneration();
    if (owner !== current) {
      seen.clear();
      owner = current;
    }
    if (!sessionId || !patch || typeof patch !== 'object') return;
    const failureId = (patch as { projectMoveFailureId?: unknown }).projectMoveFailureId;
    if (typeof failureId !== 'string' || !failureId || failureId.length > 128) return;
    const key = `${deviceId}\0${sessionId}\0${failureId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    toast.error(i18n.t('taskMove.failed'));
  };
  const offLocal = window.electronAPI.localDb.sessionsPush.onPatched(
    ({ sessionId, patch }, stamp) => {
      if (isDataOwnerPushCurrent(stamp)) report('', sessionId, patch);
    },
  );
  const offRemote = window.electronAPI.deviceLink?.onRemotePush?.((push, localStamp) => {
    if (
      push.channel !== 'local-db:sessions:patched' ||
      !isDeviceLinkRemotePushCurrent(push, localStamp)
    )
      return;
    const payload = push.payload as { sessionId?: unknown; patch?: unknown } | null;
    if (typeof payload?.sessionId === 'string')
      report(push.deviceId, payload.sessionId, payload.patch);
  });
  return () => {
    offLocal();
    offRemote?.();
    seen.clear();
  };
}
