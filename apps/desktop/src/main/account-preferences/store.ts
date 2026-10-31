/** Durable owner-scoped preference registers. Only explicit edits advance the logical clock. */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_PREFERENCE_KEYS,
  ACCOUNT_PREFERENCES_MAX_BYTES,
  accountPreferencesCounter,
  isAccountPreferenceKey,
  isAccountPreferencesNodeId,
  materializeAccountPreferences,
  mergeAccountPreferencesStates,
  normalizeAccountPreferenceValue,
  parseAccountPreferenceValues,
  parseAccountPreferencesState,
  type AccountPreferencesState,
} from '@cindy/device-link';
import type {
  AccountPreferenceWriteRequest,
  AccountPreferencesLegacyImportRequest,
  AccountPreferencesSnapshot,
} from '../../shared/accountPreferences.js';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { createLogger } from '../logger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface StoredPreferences {
  version: 1;
  nodeId: string;
  counter: number;
  state: AccountPreferencesState;
  legacyImported: boolean;
}

export interface AccountPreferencesChange {
  snapshot: AccountPreferencesSnapshot;
  origin: 'local' | 'remote';
}

const FILE_NAME = 'account-preferences.json';
const LEGACY_CLAIM_FILE = 'account-preferences-legacy-owner.v1.json';
const log = createLogger('account-preferences:store');
const listeners = new Set<(change: AccountPreferencesChange) => void>();
const initialNodeIds = new Map<string, string>();

function requireActiveOwner(request?: DataOwnerPushStamp): { stamp: DataOwnerPushStamp; scope: string } {
  const stamp = getActiveDataOwnerPushStamp();
  if (isAppSessionBoundaryPending() || !stamp.dataOwnerId
    || (request && (request.dataOwnerId !== stamp.dataOwnerId
      || request.ownerGeneration !== stamp.ownerGeneration))) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during preference operation');
  }
  return { stamp, scope: activeOwnerScopeKey() };
}

function assertCurrent(scope: string): void {
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during preference operation');
  }
}

/** Atomic backups are recovered before reading. Invalid/newer files are preserved and block writes. */
function readJson(filePath: string, maxBytes: number): unknown | null {
  try {
    for (const candidate of [filePath, `${filePath}.bak`]) {
      try {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.size > maxBytes) {
          throwIpcError('PRECONDITION_FAILED', 'preference storage is unavailable');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const text = readAtomicFileSync(filePath);
    if (text === null) return null;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throwIpcError('PRECONDITION_FAILED', 'preference storage is unavailable');
    }
    return JSON.parse(text);
  } catch (error) {
    if (isIpcError(error)) throw error;
    return throwIpcError('PRECONDITION_FAILED', 'preference storage is unavailable');
  }
}

function readStored(filePath: string): StoredPreferences {
  const raw = readJson(filePath, ACCOUNT_PREFERENCES_MAX_BYTES);
  if (raw === null) {
    let nodeId = initialNodeIds.get(filePath);
    if (!nodeId) { nodeId = randomUUID(); initialNodeIds.set(filePath, nodeId); }
    return { version: 1, nodeId, counter: 0, state: { version: 1, fields: {} }, legacyImported: false };
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
  const state = parseAccountPreferencesState(source?.state);
  if (!source || source.version !== 1 || !state || !isAccountPreferencesNodeId(source.nodeId)
    || !Number.isSafeInteger(source.counter) || (source.counter as number) < accountPreferencesCounter(state)
    || typeof source.legacyImported !== 'boolean') {
    throwIpcError('PRECONDITION_FAILED', 'preference storage has an unsupported format');
  }
  return {
    version: 1, nodeId: source.nodeId, counter: source.counter as number,
    state, legacyImported: source.legacyImported,
  };
}

function claimFilePath(): string { return path.join(app.getPath('userData'), LEGACY_CLAIM_FILE); }

function readLegacyOwner(): string | null {
  const raw = readJson(claimFilePath(), 1024);
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as { version?: unknown }).version !== 1
    || typeof (raw as { dataOwnerId?: unknown }).dataOwnerId !== 'string'
    || !(raw as { dataOwnerId: string }).dataOwnerId
    || (raw as { dataOwnerId: string }).dataOwnerId.length > 256) {
    throwIpcError('PRECONDITION_FAILED', 'legacy preference ownership is unavailable');
  }
  return (raw as { dataOwnerId: string }).dataOwnerId;
}

function canImportLegacy(stored: StoredPreferences, stamp: DataOwnerPushStamp): boolean {
  if (stored.legacyImported || !stamp.dataOwnerId) return false;
  const owner = readLegacyOwner();
  return owner === null || owner === stamp.dataOwnerId;
}

function toSnapshot(stored: StoredPreferences, stamp: DataOwnerPushStamp): AccountPreferencesSnapshot {
  return { ...stamp, values: materializeAccountPreferences(stored.state), legacyImportAllowed: canImportLegacy(stored, stamp) };
}

async function claimLegacyOwner(stamp: DataOwnerPushStamp, scope: string): Promise<boolean> {
  const filePath = claimFilePath();
  return withCrossProcessLock(`${filePath}.lock`, { label: 'account-preferences-legacy-owner' }, async status => {
    if (!status.held) throwIpcError('PRECONDITION_FAILED', 'legacy preference ownership is busy');
    assertCurrent(scope);
    const claimed = readLegacyOwner();
    if (claimed !== null) return claimed === stamp.dataOwnerId;
    // Publish complete bytes under a global claim lock, so a crash cannot leave an empty claim.
    try { atomicWriteFileSync(filePath, JSON.stringify({ version: 1, dataOwnerId: stamp.dataOwnerId })); }
    catch { throwIpcError('PRECONDITION_FAILED', 'legacy preference ownership could not be saved'); }
    return true;
  });
}

function writeStored(filePath: string, stored: StoredPreferences): void {
  const text = JSON.stringify(stored);
  if (Buffer.byteLength(text, 'utf8') > ACCOUNT_PREFERENCES_MAX_BYTES) {
    throwIpcError('PRECONDITION_FAILED', 'preference storage exceeds its size limit');
  }
  try { atomicWriteFileSync(filePath, text); }
  catch { throwIpcError('PRECONDITION_FAILED', 'account preferences could not be saved'); }
}

function nextCounter(stored: StoredPreferences): number {
  if (stored.counter >= Number.MAX_SAFE_INTEGER) {
    throwIpcError('PRECONDITION_FAILED', 'preference revision limit reached');
  }
  stored.counter += 1;
  return stored.counter;
}

function notify(snapshot: AccountPreferencesSnapshot, origin: AccountPreferencesChange['origin']): void {
  for (const listener of listeners) {
    try { listener({ snapshot, origin }); }
    catch { log.warn('preference change notification failed after durable save'); }
  }
}

export function onAccountPreferencesChanged(listener: (change: AccountPreferencesChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function loadAccountPreferencesSnapshot(): AccountPreferencesSnapshot {
  const { stamp } = requireActiveOwner();
  return toSnapshot(readStored(ownerScopedUserDataPath(FILE_NAME)), stamp);
}

export function readAccountPreferencesSyncState(): AccountPreferencesState {
  requireActiveOwner();
  return readStored(ownerScopedUserDataPath(FILE_NAME)).state;
}

export async function setAccountPreference(request: AccountPreferenceWriteRequest): Promise<AccountPreferencesSnapshot> {
  if (!isDataOwnerPushStamp(request) || !isAccountPreferenceKey(request.key)) {
    throwIpcError('INVALID_PARAMS', 'invalid account preference request');
  }
  const value = normalizeAccountPreferenceValue(request.key, request.value);
  if (value === undefined) throwIpcError('INVALID_PARAMS', 'invalid account preference value');
  const { stamp, scope } = requireActiveOwner(request);
  const filePath = ownerScopedUserDataPath(FILE_NAME);
  let changed = false;
  const snapshot = await withCrossProcessLock(`${filePath}.lock`, { label: 'account-preferences' }, async status => {
    if (!status.held) throwIpcError('PRECONDITION_FAILED', 'preference storage is busy');
    assertCurrent(scope);
    const stored = readStored(filePath);
    const previous = stored.state.fields[request.key];
    if (!previous || previous.value !== value) {
      stored.state.fields[request.key] = { value, nodeId: stored.nodeId, counter: nextCounter(stored) };
      changed = true;
    }
    const next = toSnapshot(stored, stamp);
    if (changed) writeStored(filePath, stored);
    return next;
  });
  assertCurrent(scope);
  if (changed) notify(snapshot, 'local');
  return snapshot;
}

export async function importLegacyAccountPreferences(request: AccountPreferencesLegacyImportRequest): Promise<AccountPreferencesSnapshot> {
  const values = parseAccountPreferenceValues(request?.values);
  if (!isDataOwnerPushStamp(request) || !values) {
    throwIpcError('INVALID_PARAMS', 'invalid legacy preferences');
  }
  const { stamp, scope } = requireActiveOwner(request);
  const filePath = ownerScopedUserDataPath(FILE_NAME);
  let changed = false;
  const snapshot = await withCrossProcessLock(`${filePath}.lock`, { label: 'account-preferences' }, async status => {
    if (!status.held) throwIpcError('PRECONDITION_FAILED', 'preference storage is busy');
    assertCurrent(scope);
    const stored = readStored(filePath);
    if (!stored.legacyImported && await claimLegacyOwner(stamp, scope)) {
      assertCurrent(scope);
      for (const key of ACCOUNT_PREFERENCE_KEYS) {
        if (Object.hasOwn(stored.state.fields, key) || !Object.hasOwn(values, key)) continue;
        stored.state.fields[key] = { value: values[key]!, nodeId: stored.nodeId, counter: nextCounter(stored) };
      }
      stored.legacyImported = true;
      writeStored(filePath, stored);
      changed = true;
    }
    return toSnapshot(stored, stamp);
  });
  assertCurrent(scope);
  if (changed) notify(snapshot, 'local');
  return snapshot;
}

export async function mergeAccountPreferencesSyncState(
  raw: AccountPreferencesState,
  isSourceCurrent: () => boolean = () => true,
): Promise<boolean> {
  const remote = parseAccountPreferencesState(raw);
  if (!remote) throwIpcError('INVALID_PARAMS', 'invalid preference sync state');
  const { stamp, scope } = requireActiveOwner();
  if (!isSourceCurrent()) return false;
  const filePath = ownerScopedUserDataPath(FILE_NAME);
  let snapshot: AccountPreferencesSnapshot | undefined;
  const changed = await withCrossProcessLock(`${filePath}.lock`, { label: 'account-preferences' }, async status => {
    if (!status.held) throwIpcError('PRECONDITION_FAILED', 'preference storage is busy');
    assertCurrent(scope);
    if (!isSourceCurrent()) return false;
    const stored = readStored(filePath);
    const merged = mergeAccountPreferencesStates(stored.state, remote);
    if (!merged.changed) return false;
    stored.state = merged.state;
    stored.counter = Math.max(stored.counter, accountPreferencesCounter(merged.state));
    snapshot = toSnapshot(stored, stamp);
    writeStored(filePath, stored);
    return true;
  });
  assertCurrent(scope);
  if (changed && snapshot) notify(snapshot, 'remote');
  return changed;
}
