/**
 * Stable application-session identity shared by auth, local data and secret stores.
 *
 * Only the mode is persisted. A cloud owner is accepted only after auth has
 * verified a real membership for the current process; local mode always uses
 * the reserved owner below and never masquerades as a server user id.
 */
import { app } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';

import { createLogger } from './logger.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import type { DataOwnerPushStamp } from '../shared/dataOwnerPush.js';

export type AppSessionMode = 'signed-out' | 'local' | 'cloud';

export interface ActiveAppSession {
  mode: AppSessionMode;
  dataOwnerId: string | null;
  generation: number;
}

/** Backward-compatible name for the canonical Profile model constant. */
export const LOCAL_DATA_OWNER_ID = LOCAL_PROFILE_DATA_OWNER_ID;

/** Filesystem/storage-safe opaque namespace for a data owner. */
export function dataOwnerStorageKey(ownerId: string): string {
  return crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
}

/**
 * Resolve private application state beneath the active owner's namespace.
 * Callers must not silently fall back to the shared userData root: doing so
 * would make signed-out startup or an account switch cross-contaminate data.
 */
export function ownerScopedUserDataPath(...parts: string[]): string {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) {
    // Some services register before authentication settles. Give them an
    // ephemeral process namespace so they can initialize without ever
    // reading or writing a real owner's private state.
    return path.join(app.getPath('temp'), 'cindy-no-session', String(process.pid), ...parts);
  }
  return path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId), ...parts);
}

interface PersistedAppSessionSettings {
  activeMode: AppSessionMode;
}

const log = createLogger('appSessionState');
const DEFAULTS: PersistedAppSessionSettings = { activeMode: 'signed-out' };

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'app-session.json');
}

function normalize(raw: unknown): PersistedAppSessionSettings {
  const activeMode =
    raw && typeof raw === 'object'
      ? (raw as { activeMode?: unknown }).activeMode
      : undefined;
  return {
    activeMode:
      activeMode === 'local' || activeMode === 'cloud' || activeMode === 'signed-out'
        ? activeMode
        : 'signed-out',
  };
}

const store = createOverrideSettingsFile<PersistedAppSessionSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'app session',
});

let active: ActiveAppSession | null = null;
let boundaryDepth = 0;
let appSessionCommitBoundaryHook: (() => void) | null = null;

/**
 * Register synchronous owner-scoped runtime invalidation at the exact commit edge.
 * The hook runs after the commit has been accepted but before the new owner is
 * visible, so stale async work cannot resume into the next owner's process state.
 */
export function setAppSessionCommitBoundaryHook(hook: (() => void) | null): void {
  appSessionCommitBoundaryHook = hook;
}

function ensureLoaded(): ActiveAppSession {
  if (active) return active;
  const persistedMode = store.read().activeMode;
  // Cloud is only an intent at process start. It becomes an active session
  // after auth verifies the persisted refresh token and supplies its owner.
  const initialMode: AppSessionMode = persistedMode === 'local' ? 'local' : 'signed-out';
  active = {
    mode: initialMode,
    dataOwnerId: initialMode === 'local' ? LOCAL_DATA_OWNER_ID : null,
    generation: 0,
  };
  return active;
}

/** Read the last committed stable session. */
export function getActiveAppSession(): ActiveAppSession {
  return { ...ensureLoaded() };
}

/** Snapshot the owner boundary for a live main → renderer/device-link frame. */
export function getActiveDataOwnerPushStamp(): DataOwnerPushStamp {
  const session = ensureLoaded();
  return {
    dataOwnerId: session.dataOwnerId,
    ownerGeneration: session.generation,
  };
}

/**
 * Opaque key identifying "which account is active right now".
 *
 * Any owner-scoped read or write that spans an `await` must capture this before
 * the wait and re-check it after, then drop the operation when it no longer
 * matches — otherwise account A's data lands in account B's storage or UI.
 * `generation` advances on every mode/owner commit, so the key changes even if
 * the same owner is re-committed.
 *
 * Single source of truth on purpose: this invariant was first fixed per-call-site
 * and each missed call site became its own bug.
 */
export function activeOwnerScopeKey(): string {
  const session = ensureLoaded();
  return `${session.mode}:${session.dataOwnerId ?? 'none'}:${session.generation}`;
}

/**
 * Fail closed while owner-bound runtimes are being torn down or replaced.
 * The returned release function is idempotent so error paths can safely use it
 * from `finally` blocks.
 */
export function beginAppSessionBoundary(): () => void {
  boundaryDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    boundaryDepth = Math.max(0, boundaryDepth - 1);
  };
}

export function isAppSessionBoundaryPending(): boolean {
  return boundaryDepth > 0;
}

/** Backward-compatible alias for the process-local application transition. */
export function isAppSessionBoundaryLocallyPending(): boolean {
  return boundaryDepth > 0;
}

/**
 * Commit a stable session after its required runtime is ready.
 * Cloud commits require a verified membership id; local uses the reserved id.
 */
export function commitActiveAppSession(
  mode: AppSessionMode,
  cloudOwnerId?: string | null,
  forceBumpGeneration = false,
): ActiveAppSession {
  const previous = ensureLoaded();
  let dataOwnerId: string | null = null;
  if (mode === 'local') {
    dataOwnerId = LOCAL_DATA_OWNER_ID;
  } else if (mode === 'cloud') {
    const normalized = cloudOwnerId?.trim();
    if (!normalized) throw new Error('cloud app session requires a verified data owner');
    dataOwnerId = normalized;
  }
  const ownerChanged = previous.mode !== mode || previous.dataOwnerId !== dataOwnerId;

  if (!ownerChanged && !forceBumpGeneration) {
    return { ...previous };
  }

  store.writePatch({ activeMode: mode });
  if (ownerChanged) appSessionCommitBoundaryHook?.();
  active = {
    mode,
    dataOwnerId,
    generation: previous.generation + 1,
  };
  log.info('stable app session committed', {
    mode,
    dataOwnerId,
    generation: active.generation,
  });
  return { ...active };
}

/** Update only this process after a passive instance signs out or is quarantined. */
export function commitVolatileAppSession(
  mode: AppSessionMode,
  cloudOwnerId?: string | null,
): ActiveAppSession {
  const previous = ensureLoaded();
  let dataOwnerId: string | null = null;
  if (mode === 'local') {
    dataOwnerId = LOCAL_DATA_OWNER_ID;
  } else if (mode === 'cloud') {
    const normalized = cloudOwnerId?.trim();
    if (!normalized) throw new Error('cloud app session requires a verified data owner');
    dataOwnerId = normalized;
  }
  if (previous.mode === mode && previous.dataOwnerId === dataOwnerId) {
    return { ...previous };
  }
  appSessionCommitBoundaryHook?.();
  active = {
    mode,
    dataOwnerId,
    generation: previous.generation + 1,
  };
  log.info('volatile app session committed', {
    mode,
    dataOwnerId,
    generation: active.generation,
  });
  return { ...active };
}

export const __testing = { normalize };
