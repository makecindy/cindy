/**
 * Renderer mirror and write bridge for queued offline inbox intents (`snooze` / `complete`).
 * Main owns disk persistence per account (`main/device-link/offlineInboxIntentStore.ts`) and
 * broadcasts changes across all windows.
 */

import { useSyncExternalStore } from 'react';
import {
  createOfflineCompleteIntent,
  normalizeOfflineInboxIntents,
  offlineInboxIntentKey,
  resolveOfflineSnoozeIntent,
  type OfflineInboxIntent,
  type OfflineInboxSessionSnapshot,
} from '@cindy/maker-shared/offline-inbox-intent';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';

const log = createLogger('device-link:offline-inbox');

type OfflineInboxBridge = typeof window.electronAPI.deviceLink.offlineInboxIntents;

function bridge(): OfflineInboxBridge | null {
  if (typeof window === 'undefined') return null;
  return (window.electronAPI?.deviceLink?.offlineInboxIntents as OfflineInboxBridge | undefined) ?? null;
}

let intentsByKey = new Map<string, OfflineInboxIntent>();
let revision = 0;
let writeSeq = 0;
const keyWriteSeq = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function replaceAll(raw: unknown): void {
  const next = new Map<string, OfflineInboxIntent>();
  for (const intent of normalizeOfflineInboxIntents(raw)) {
    next.set(offlineInboxIntentKey(intent.deviceId, intent.sessionId), intent);
  }
  if (
    next.size === intentsByKey.size &&
    [...next].every(([key, value]) => JSON.stringify(intentsByKey.get(key)) === JSON.stringify(value))
  ) {
    return;
  }
  intentsByKey = next;
  emit();
}

export function subscribeOfflineInboxIntents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOfflineInboxIntentsRevision(): number {
  return revision;
}

export function useOfflineInboxIntentsRevision(): number {
  return useSyncExternalStore(
    subscribeOfflineInboxIntents,
    getOfflineInboxIntentsRevision,
    getOfflineInboxIntentsRevision,
  );
}

export function getOfflineInboxIntent(
  deviceId: string | null | undefined,
  sessionId: string | null | undefined,
): OfflineInboxIntent | undefined {
  if (!deviceId || !sessionId) return undefined;
  return intentsByKey.get(offlineInboxIntentKey(deviceId, sessionId));
}

export function useOfflineInboxIntent(
  deviceId: string | null | undefined,
  sessionId: string | null | undefined,
): OfflineInboxIntent | undefined {
  return useSyncExternalStore(
    subscribeOfflineInboxIntents,
    () => getOfflineInboxIntent(deviceId, sessionId),
    () => undefined,
  );
}

export function getOfflineInboxIntentsForDevice(deviceId: string): OfflineInboxIntent[] {
  const trimmed = deviceId.trim();
  if (!trimmed) return [];
  const list: OfflineInboxIntent[] = [];
  for (const intent of intentsByKey.values()) {
    if (intent.deviceId === trimmed) list.push(intent);
  }
  return list;
}

export function listAllOfflineInboxIntents(): OfflineInboxIntent[] {
  return [...intentsByKey.values()];
}

export async function upsertOfflineInboxIntent(intent: OfflineInboxIntent): Promise<void> {
  const owner = getDataOwnerGeneration();
  const key = offlineInboxIntentKey(intent.deviceId, intent.sessionId);
  const previous = intentsByKey.get(key);
  const token = (writeSeq += 1);
  keyWriteSeq.set(key, token);
  const next = new Map(intentsByKey);
  next.set(key, intent);
  intentsByKey = next;
  emit();
  const api = bridge();
  if (!api) return;
  try {
    const persisted = await api.upsert(intent);
    if (isDataOwnerGenerationCurrent(owner) && keyWriteSeq.get(key) === token) {
      replaceAll(persisted);
    }
  } catch (err) {
    log.warn('failed to persist offline inbox intent', err);
    if (isDataOwnerGenerationCurrent(owner) && keyWriteSeq.get(key) === token) {
      const rolledBack = new Map(intentsByKey);
      if (previous) rolledBack.set(key, previous);
      else rolledBack.delete(key);
      intentsByKey = rolledBack;
      emit();
    }
    throw err;
  }
}

export async function removeOfflineInboxIntent(
  deviceId: string,
  sessionId: string,
): Promise<void> {
  const owner = getDataOwnerGeneration();
  const key = offlineInboxIntentKey(deviceId, sessionId);
  const previous = intentsByKey.get(key);
  const token = (writeSeq += 1);
  keyWriteSeq.set(key, token);
  if (intentsByKey.has(key)) {
    const next = new Map(intentsByKey);
    next.delete(key);
    intentsByKey = next;
    emit();
  }
  const api = bridge();
  if (!api) return;
  try {
    const persisted = await api.remove(deviceId, sessionId);
    if (isDataOwnerGenerationCurrent(owner) && keyWriteSeq.get(key) === token) {
      replaceAll(persisted);
    }
  } catch (err) {
    log.warn('failed to remove offline inbox intent', err);
    if (isDataOwnerGenerationCurrent(owner) && keyWriteSeq.get(key) === token) {
      const rolledBack = new Map(intentsByKey);
      if (previous) rolledBack.set(key, previous);
      else rolledBack.delete(key);
      intentsByKey = rolledBack;
      emit();
    }
    throw err;
  }
}

export async function clearOfflineInboxIntentsForDevice(deviceId: string): Promise<void> {
  const trimmed = deviceId.trim();
  if (!trimmed) return;
  const owner = getDataOwnerGeneration();
  let changed = false;
  const next = new Map<string, OfflineInboxIntent>();
  for (const [key, intent] of intentsByKey) {
    if (intent.deviceId === trimmed) changed = true;
    else next.set(key, intent);
  }
  if (changed) {
    intentsByKey = next;
    emit();
  }
  const api = bridge();
  if (!api) return;
  try {
    const persisted = await api.clearDevice(trimmed);
    if (isDataOwnerGenerationCurrent(owner)) replaceAll(persisted);
  } catch (err) {
    log.warn('failed to clear device offline inbox intents', err);
  }
}

export function resetOfflineInboxIntents(): void {
  keyWriteSeq.clear();
  if (intentsByKey.size === 0) return;
  intentsByKey = new Map();
  emit();
}

export async function queueOfflineInboxSnooze(
  deviceId: string,
  sessionId: string,
  rawHostSession: OfflineInboxSessionSnapshot,
  snoozedUntil: string | null,
): Promise<void> {
  const intent = resolveOfflineSnoozeIntent(deviceId, sessionId, rawHostSession, snoozedUntil);
  if (!intent) {
    await removeOfflineInboxIntent(deviceId, sessionId);
    return;
  }
  await upsertOfflineInboxIntent(intent);
}

export async function queueOfflineInboxComplete(
  deviceId: string,
  sessionId: string,
  rawHostSession: OfflineInboxSessionSnapshot,
): Promise<void> {
  const intent = createOfflineCompleteIntent(deviceId, sessionId, rawHostSession);
  await upsertOfflineInboxIntent(intent);
}

/**
 * Hydrate persisted intents for the current account and stay synced across windows.
 * Call inside the account-scoped device-link lifecycle hook.
 */
export function startOfflineInboxIntentsSync(): () => void {
  const api = bridge();
  const owner = getDataOwnerGeneration();
  let disposed = false;
  if (api) {
    void api
      .list()
      .then((persisted) => {
        if (!disposed && isDataOwnerGenerationCurrent(owner)) replaceAll(persisted);
      })
      .catch((err: unknown) => log.debug('failed to hydrate offline inbox intents', err));
  }
  const off = api?.onChanged?.((payload) => {
    if (!disposed && isDataOwnerGenerationCurrent(owner)) replaceAll(payload?.intents);
  });
  return () => {
    disposed = true;
    off?.();
  };
}
