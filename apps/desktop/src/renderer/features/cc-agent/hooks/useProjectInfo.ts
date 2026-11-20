import { useSyncExternalStore } from 'react';
import type { HostProjectAliasesSnapshot } from '@cindy/maker-shared/project-alias-sync';
import { remoteProjectAliases } from '../../device-link/remoteProjectAliases';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

let snapshot: HostProjectAliasesSnapshot | undefined;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let revision = 0;
async function refresh() {
  const currentRevision = ++revision;
  const owner = getDataOwnerGeneration();
  try {
    const next = await window.electronAPI.localDb.projectAliases.snapshot();
    if (currentRevision !== revision || !isDataOwnerGenerationCurrent(owner)) return;
    snapshot = next;
    listeners.forEach((fn) => fn());
  } catch {
    /* The editor reports unavailable; a list keeps its last accepted image. */
  }
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (listeners.size === 1) {
    unsubscribe = window.electronAPI.localDb.projectAliases.onChanged(() => {
      void refresh();
    });
    void refresh();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
      snapshot = undefined;
      revision++;
    }
  };
}
export function useProjectInfo(deviceId: string | null) {
  const local = useSyncExternalStore(subscribe, () =>
    snapshot?.ownerStamp?.dataOwnerId === getDataOwnerGeneration().dataOwnerId
      ? snapshot
      : undefined,
  );
  const remote = useSyncExternalStore(
    remoteProjectAliases.subscribe,
    remoteProjectAliases.getSnapshot,
  );
  return deviceId ? remote.get(deviceId) : local;
}
