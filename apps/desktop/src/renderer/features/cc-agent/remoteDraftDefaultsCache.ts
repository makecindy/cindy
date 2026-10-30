import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { RemoteDraftDefaults } from './deviceLinkDraftDefaults';

// Defaults are host preferences, never inferred from running/recent sessions.
// Keep successful reads across page mounts; changing account/runtime drops them.
let owner = getDataOwnerGeneration();
const cache = new Map<string, RemoteDraftDefaults | null>();

function currentCache() {
  if (!isDataOwnerGenerationCurrent(owner)) {
    cache.clear();
    owner = getDataOwnerGeneration();
  }
  return cache;
}

export function getRemoteDraftDefaults(deviceId: string, agent: string): RemoteDraftDefaults | null | undefined {
  return currentCache().get(`${deviceId}:${agent}`);
}

export function rememberRemoteDraftDefaults(
  deviceId: string,
  agent: string,
  value: RemoteDraftDefaults | null,
  transaction?: { deviceId: string; status: string; enabled?: boolean } | null,
): void {
  // Pull, push and inline handoff must obey the same pending-write boundary.
  if (transaction?.deviceId === deviceId && transaction.status !== 'committed'
    && value?.worktreeEnabled !== transaction.enabled) return;
  // {} means the host renderer has not published its preferences yet.
  if (value && Object.keys(value).length === 0) return;
  currentCache().set(`${deviceId}:${agent}`, value);
}

export function forgetRemoteDraftDefaults(deviceId: string): void {
  for (const key of currentCache().keys()) {
    if (key.startsWith(`${deviceId}:`)) cache.delete(key);
  }
}
