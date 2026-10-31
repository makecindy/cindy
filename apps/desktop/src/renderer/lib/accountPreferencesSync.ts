import { useLayoutEffect } from 'react';
import {
  ACCOUNT_PREFERENCE_KEYS,
  normalizeAccountPreferenceValue,
  parseAccountPreferenceValues,
  type AccountPreferenceKey,
  type AccountPreferenceValues,
} from '@cindy/device-link';

import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type { AccountPreferencesSnapshot } from '../../shared/accountPreferences';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush';
import { createLogger } from './logger';

const log = createLogger('AccountPreferencesSync');
// This marker only fences the local projection. It is never sent to another device.
const PROJECTION_OWNER_KEY = 'accountPreferences.projectionOwner.v1';
let projectionOwner: string | null | undefined;

interface PendingPreference {
  key: AccountPreferenceKey;
  value: string | null;
}

interface PreferenceBridge {
  current: () => boolean;
  write: (key: AccountPreferenceKey, value: string | null) => void;
}

let activeBridge: PreferenceBridge | null = null;

/** Called only for an explicit local edit; replaying a snapshot never calls this. */
export function notifyLocalPreferenceChanged(key: AccountPreferenceKey, rawValue: string | null): void {
  const value = normalizeAccountPreferenceValue(key, rawValue);
  if (value !== undefined && activeBridge?.current()) activeBridge.write(key, value);
}

function readProjectionOwner(): string | null {
  try {
    projectionOwner = localStorage.getItem(PROJECTION_OWNER_KEY);
  } catch { /* Retain the in-memory boundary if storage is unavailable. */ }
  return projectionOwner ?? null;
}

function markProjectionOwner(ownerId: string): void {
  projectionOwner = ownerId;
  try { localStorage.setItem(PROJECTION_OWNER_KEY, ownerId); } catch { /* memory fence remains */ }
}

function projectPreference(key: AccountPreferenceKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Mounted consumers still receive the authoritative value below. */ }
  const event = new Event('storage');
  Object.defineProperties(event, { key: { value: key }, newValue: { value } });
  window.dispatchEvent(event);
}

/** Preserve old boolean card modes and the existing versioned task-info list on first claim. */
function readLegacyPreferences(): AccountPreferenceValues {
  const values: AccountPreferenceValues = {};
  for (const key of ACCOUNT_PREFERENCE_KEYS) {
    let value: string | null;
    try { value = localStorage.getItem(key); } catch { continue; }
    if (value === null) continue;
    if (key === 'sidebar.cardMode') {
      if (value === 'true') value = 'card';
      if (value === 'false') value = 'text';
    }
    if (key === 'cc-agent.sidebar.filter.taskInfo') {
      try {
        const parsed: unknown = JSON.parse(value);
        const fields = Array.isArray(parsed) ? parsed
          : parsed && typeof parsed === 'object' && 'version' in parsed
            && parsed.version === 1 && 'fields' in parsed ? parsed.fields : null;
        if (Array.isArray(fields)) {
          // The existing loader discards retired fields (for example "tags") and duplicates.
          const valid = fields.filter((field, index) => fields.indexOf(field) === index
            && normalizeAccountPreferenceValue(key, JSON.stringify([field])) !== undefined);
          value = JSON.stringify(valid);
        }
      } catch { continue; }
    }
    const normalized = normalizeAccountPreferenceValue(key, value);
    if (normalized !== undefined) values[key] = normalized;
  }
  // The existing main-list loader derives its first explicit mode from the old pin mode.
  if (values['sidebar.mainListMode'] === undefined && values['sidebar.cardMode'] !== undefined) {
    values['sidebar.mainListMode'] = values['sidebar.cardMode'] === 'text' ? 'text' : 'list';
  }
  return values;
}

/** Mount inside AuthProvider. Main owns durable state, conflict resolution and transport. */
export function useAccountPreferencesSync(ownerId: string | null, ownerGeneration: number): void {
  useLayoutEffect(() => {
    const api = window.electronAPI?.accountPreferences;
    if (!ownerId || !api) return;
    const stamp: DataOwnerPushStamp = { dataOwnerId: ownerId, ownerGeneration };
    if (!isDataOwnerPushStampCurrent(stamp)) return;
    let disposed = false;
    let initialized = false;
    let pushCount = 0;
    let latest: AccountPreferencesSnapshot | null = null;
    let queue: Promise<void> = Promise.resolve();
    const pending = new Map<AccountPreferenceKey, PendingPreference>();
    const current = () => !disposed && isDataOwnerPushStampCurrent(stamp);
    const previousOwner = readProjectionOwner();
    const canImportProjection = previousOwner === null || previousOwner === ownerId;
    const legacy = canImportProjection ? readLegacyPreferences() : {};

    const apply = (snapshot: AccountPreferencesSnapshot): void => {
      if (!current() || snapshot.dataOwnerId !== ownerId
        || snapshot.ownerGeneration !== ownerGeneration) return;
      const values = parseAccountPreferenceValues(snapshot.values);
      if (!values) return;
      latest = snapshot;
      markProjectionOwner(ownerId);
      for (const key of ACCOUNT_PREFERENCE_KEYS) {
        projectPreference(key, pending.has(key) ? pending.get(key)!.value : values[key] ?? null);
      }
    };

    const enqueue = (edit: PendingPreference): void => {
      queue = queue.then(async () => {
        if (!current()) return;
        const pushesBeforeWrite = pushCount;
        try {
          const snapshot = await api.set({ ...stamp, ...edit });
          if (!current()) return;
          if (pending.get(edit.key) === edit) pending.delete(edit.key);
          // A push received while writing is at least as fresh as this RPC reply.
          if (pushCount === pushesBeforeWrite) apply(snapshot);
          else if (latest) apply(latest);
        } catch (error) {
          if (!current()) return;
          if (pending.get(edit.key) === edit) pending.delete(edit.key);
          if (latest) apply(latest);
          log.warn('failed to save account preference', error);
        }
      });
    };

    const bridge: PreferenceBridge = {
      current,
      write(key, value) {
        const edit = { key, value };
        pending.set(key, edit);
        if (initialized) enqueue(edit);
      },
    };
    activeBridge = bridge;
    // Never display or import the preceding account's unscoped projection.
    if (!canImportProjection) {
      markProjectionOwner(ownerId);
      for (const key of ACCOUNT_PREFERENCE_KEYS) projectPreference(key, null);
    }
    const off = api.onChanged((snapshot) => {
      if (!current() || snapshot.dataOwnerId !== ownerId
        || snapshot.ownerGeneration !== ownerGeneration) return;
      pushCount += 1;
      apply(snapshot);
    });
    void (async () => {
      try {
        const pushesBeforeLoad = pushCount;
        let snapshot = await api.load();
        if (!current()) return;
        if (pushCount !== pushesBeforeLoad && latest) snapshot = latest;
        if (snapshot.dataOwnerId !== ownerId || snapshot.ownerGeneration !== ownerGeneration) return;
        if (snapshot.legacyImportAllowed) {
          // An empty claim is intentional: it consumes legacy migration without importing another owner.
          const pushesBeforeImport = pushCount;
          const imported = await api.importLegacy({ ...stamp, values: legacy });
          if (!current()) return;
          snapshot = pushCount !== pushesBeforeImport && latest ? latest : imported;
        }
        apply(snapshot);
        initialized = true;
        for (const edit of pending.values()) enqueue(edit);
      } catch (error) {
        if (current()) log.warn('failed to load account preferences', error);
      }
    })();

    return () => {
      disposed = true;
      pending.clear();
      off();
      if (activeBridge === bridge) activeBridge = null;
    };
  }, [ownerId, ownerGeneration]);
}
