/**
 * Owner-scoped sidebar identity state.
 *
 * The main process owns the durable snapshot and binds every mutation and
 * broadcast to the account generation that initiated it. Renderer windows
 * only keep optimistic mirrors.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import { isIpcError } from '../shared/ipc-errors.js';
import { normalizeProjectKey, projectKeyComparisonKey } from '../shared/projectKeys.js';
import {
  normalizeSidebarPinnedOrder,
  SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES,
  SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH,
  SIDEBAR_PINNED_ORDER_MAX_ENTRIES,
  isSidebarGhostId,
  type SidebarMainViewHiddenWriteRequest,
  type SidebarPinnedOrderMutation,
  type SidebarPinnedOrderWriteRequest,
  type SidebarLegacyRendererOwnerClaim,
  type SidebarProjectHiddenWriteRequest,
  type SidebarSettingsSnapshot,
} from '../shared/sidebarSettings.js';
import {
  activeOwnerScopeKey,
  dataOwnerStorageKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createLogger } from './logger.js';
import { resumeInputDeviceTaskSlots } from './input-devices/registry.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import {
  hasExclusiveSharedLegacyUserDataAccess,
  isLegacyOwnerNamespaceClaimOwnedBy,
  isLegacyOwnerNamespaceClaimedByOtherOwner,
} from './ownerNamespaceMigration.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface SidebarSettingsShape {
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
  hiddenMainViewGhostIds: string[];
}

const DEFAULTS: SidebarSettingsShape = {
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};
const MAX_HIDDEN_PROJECT_ENTRIES = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const SETTINGS_FILE_NAME = 'sidebar-settings.json';
const LEGACY_RENDERER_OWNER_MARKER_FILE = 'sidebar-renderer-legacy-owner.v1.json';
const MAX_LEGACY_RENDERER_OWNER_MARKER_BYTES = 1_024;
// An explicit empty scoped snapshot must remain durable, otherwise a preserved
// legacy file could become authoritative again after the user clears the list.
const SIDEBAR_WRITE_OPTIONS = { preserveDefaults: true } as const;

const log = createLogger('sidebar-settings');
const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<SidebarSettingsShape>>
>();
const writeChains = new Map<string, Promise<unknown>>();

function normalizeHiddenProjectKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    const projectKey = normalizeProjectKey(entry);
    const comparisonKey = projectKeyComparisonKey(projectKey, process.platform);
    if (
      projectKey == null ||
      projectKey.length > MAX_PROJECT_KEY_LENGTH ||
      comparisonKey == null ||
      seen.has(comparisonKey)
    ) {
      continue;
    }
    seen.add(comparisonKey);
    normalized.push(projectKey);
    if (normalized.length >= MAX_HIDDEN_PROJECT_ENTRIES) break;
  }
  return normalized;
}

function normalizeHiddenMainViewGhostIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (!isSidebarGhostId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
    if (normalized.length >= SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES) break;
  }
  return normalized;
}

function normalizeSettings(raw: unknown): SidebarSettingsShape {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    pinnedOrder: normalizeSidebarPinnedOrder(value.pinnedOrder),
    hiddenProjectKeys: normalizeHiddenProjectKeys(value.hiddenProjectKeys),
    hiddenMainViewGhostIds: normalizeHiddenMainViewGhostIds(value.hiddenMainViewGhostIds),
  };
}

function sidebarSettingsErrorCode(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  return typeof code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : 'INVALID_SETTINGS';
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function currentStore() {
  const session = getActiveAppSession();
  if (!session.dataOwnerId) {
    throwIpcError('PRECONDITION_FAILED', 'sidebar settings require an active data owner');
  }
  const ownerRoot = ownerScopedUserDataPath();
  let store = stores.get(ownerRoot);
  if (!store) {
    store = createOverrideSettingsFile<SidebarSettingsShape>({
      filePath: () => path.join(ownerRoot, SETTINGS_FILE_NAME),
      defaults: DEFAULTS,
      normalize: normalizeSettings,
      log,
      label: 'sidebar',
      scopeKey: activeOwnerScopeKey,
      maxBytes: MAX_SETTINGS_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
    });
    stores.set(ownerRoot, store);
  }
  return store;
}

type SidebarStoreAccessResult = 'blocked' | 'ready' | 'snapshot-changed';

function sidebarStoreAccessResult(): SidebarStoreAccessResult {
  const session = getActiveAppSession();
  if (!session.dataOwnerId) return 'blocked';
  if (session.mode !== 'local' && session.mode !== 'cloud') return 'blocked';

  const scopedPathState = scopedSidebarPathState(ownerScopedUserDataPath(SETTINGS_FILE_NAME));
  // The old schema cannot express unpin/unhide tombstones. Once scoped state
  // exists, it is the sole authority; preserve any conflicting legacy bytes.
  if (scopedPathState === 'regular-file') return 'ready';
  if (scopedPathState === 'blocked') return 'blocked';

  if (session.mode === 'local') return 'ready';
  return claimLegacySidebarSettingsResult();
}

function requireSidebarStoreAccess(options: { rejectSnapshotChange?: boolean } = {}): void {
  const result = sidebarStoreAccessResult();
  if (result === 'blocked') {
    throwIpcError('PRECONDITION_FAILED', 'sidebar settings migration is pending');
  }
  if (options.rejectSnapshotChange && result === 'snapshot-changed') {
    throwIpcError('PRECONDITION_FAILED', 'sidebar settings changed during mutation');
  }
}

function hasAuthoritativePinnedOrder(customizedKeys: readonly string[]): boolean {
  // Historical electron-store files may contain an auto-written empty default
  // that is indistinguishable from an explicit clear. Product policy prefers
  // preserving the durable empty state over reviving stale Renderer storage.
  return customizedKeys.includes('pinnedOrder');
}

function readCurrentSettings(): {
  settings: SidebarSettingsShape;
  pinnedOrderIsAuthoritative: boolean;
} {
  const accessResult = sidebarStoreAccessResult();
  if (accessResult === 'blocked') {
    return { settings: { ...DEFAULTS }, pinnedOrderIsAuthoritative: false };
  }
  const store = currentStore();
  store.invalidateIfChanged();
  const current = store.readState();
  return {
    settings: current.value,
    pinnedOrderIsAuthoritative: hasAuthoritativePinnedOrder(current.customizedKeys),
  };
}

export function loadSidebarSettingsSnapshot(): SidebarSettingsSnapshot {
  const stamp = getActiveDataOwnerPushStamp();
  const current = stamp.dataOwnerId
    ? readCurrentSettings()
    : { settings: DEFAULTS, pinnedOrderIsAuthoritative: false };
  return {
    ...stamp,
    pinnedOrderIsAuthoritative: current.pinnedOrderIsAuthoritative,
    pinnedOrder: Array.from(current.settings.pinnedOrder),
    hiddenProjectKeys: Array.from(current.settings.hiddenProjectKeys),
    hiddenMainViewGhostIds: Array.from(current.settings.hiddenMainViewGhostIds),
  };
}

function requirePinnedOrder(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > SIDEBAR_PINNED_ORDER_MAX_ENTRIES ||
    raw.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.length > SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH,
    ) ||
    new Set(raw).size !== raw.length
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar pinned order');
  }
  return Array.from(raw as string[]);
}

function requirePinnedEntry(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar pinned entry');
  }
  return raw;
}

function requirePinnedMutation(raw: unknown): SidebarPinnedOrderMutation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar pinned mutation');
  }
  const mutation = raw as Record<string, unknown>;
  switch (mutation.kind) {
    case 'promote':
    case 'remove':
      return { kind: mutation.kind, entryId: requirePinnedEntry(mutation.entryId) };
    case 'migrate-legacy':
      return { kind: mutation.kind, order: requirePinnedOrder(mutation.order) };
    case 'reorder':
      return {
        kind: mutation.kind,
        baseOrder: requirePinnedOrder(mutation.baseOrder),
        order: requirePinnedOrder(mutation.order),
      };
    default:
      throwIpcError('INVALID_PARAMS', 'invalid sidebar pinned mutation');
  }
}

/**
 * Rebase a drag that started from `baseOrder` onto the latest durable order.
 * Entries added by another window keep their current list slot (so a recent
 * promote stays first); entries removed by another window are never resurrected.
 */
function rebasePinnedReorder(
  current: readonly string[],
  baseOrder: readonly string[],
  desiredOrder: readonly string[],
): string[] {
  const baseSet = new Set(baseOrder);
  const currentSet = new Set(current);
  const result = desiredOrder.filter((entry) => !baseSet.has(entry) || currentSet.has(entry));
  const resultSet = new Set(result);

  for (let index = 0; index < current.length; index += 1) {
    const entry = current[index];
    if (baseSet.has(entry) || resultSet.has(entry)) continue;
    result.splice(Math.min(index, result.length), 0, entry);
    resultSet.add(entry);
  }

  return normalizeSidebarPinnedOrder(result);
}

function applyPinnedMutation(
  current: readonly string[],
  mutation: SidebarPinnedOrderMutation,
  pinnedOrderIsAuthoritative: boolean,
): string[] {
  switch (mutation.kind) {
    case 'promote':
      return current[0] === mutation.entryId
        ? Array.from(current)
        : [mutation.entryId, ...current.filter((entry) => entry !== mutation.entryId)];
    case 'remove':
      return current.filter((entry) => entry !== mutation.entryId);
    case 'migrate-legacy':
      return pinnedOrderIsAuthoritative ? Array.from(current) : Array.from(mutation.order);
    case 'reorder':
      return rebasePinnedReorder(current, mutation.baseOrder, mutation.order);
  }
}

function requireProjectKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PROJECT_KEY_LENGTH) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project key');
  }
  const projectKey = normalizeProjectKey(raw);
  if (
    projectKey == null ||
    projectKey.length > MAX_PROJECT_KEY_LENGTH ||
    (!projectKey.startsWith('local:') &&
      !projectKey.startsWith('remote:') &&
      !projectKey.startsWith('device:'))
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project key');
  }
  return projectKey;
}

function requireGhostId(raw: unknown): string {
  if (!isSidebarGhostId(raw)) {
    throwIpcError('INVALID_PARAMS', 'invalid main-view plugin id');
  }
  return raw;
}

function requireWriteRequest(raw: unknown): Record<string, unknown> & DataOwnerPushStamp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isDataOwnerPushStamp(raw)) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar owner stamp');
  }
  return raw as Record<string, unknown> & DataOwnerPushStamp;
}

function assertRequestedOwner(request: DataOwnerPushStamp): void {
  const current = getActiveDataOwnerPushStamp();
  if (
    isAppSessionBoundaryPending() ||
    !current.dataOwnerId ||
    current.dataOwnerId !== request.dataOwnerId ||
    current.ownerGeneration !== request.ownerGeneration
  ) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
  }
}

function enqueueWrite<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(scopeKey) ?? Promise.resolve();
  const run = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
    }
    return task();
  };
  const next = previous.then(run, run);
  const tracked: Promise<T> = next.finally(() => {
    if (writeChains.get(scopeKey) === tracked) writeChains.delete(scopeKey);
  });
  writeChains.set(scopeKey, tracked);
  return tracked;
}

function assertScopeCurrent(scopeKey: string): void {
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
  }
}

function broadcastPinnedOrderChanged(
  order: readonly string[],
  ownerStamp: DataOwnerPushStamp,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isAppContentWindow(window)) continue;
    window.webContents.send('sidebar-settings:pinned-order-changed', Array.from(order), ownerStamp);
  }
}

function broadcastHiddenProjectKeysChanged(
  projectKeys: readonly string[],
  ownerStamp: DataOwnerPushStamp,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isAppContentWindow(window)) continue;
    window.webContents.send(
      'sidebar-settings:hidden-project-keys-changed',
      Array.from(projectKeys),
      ownerStamp,
    );
  }
}

function broadcastHiddenMainViewGhostIdsChanged(
  ghostIds: readonly string[],
  ownerStamp: DataOwnerPushStamp,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isAppContentWindow(window)) continue;
    window.webContents.send(
      'sidebar-settings:hidden-main-view-ghost-ids-changed',
      Array.from(ghostIds),
      ownerStamp,
    );
  }
}

async function savePinnedOrder(rawRequest: unknown): Promise<string[]> {
  const request = requireWriteRequest(rawRequest);
  const mutation = requirePinnedMutation(request.mutation);
  assertRequestedOwner(request);
  const scopeKey = activeOwnerScopeKey();
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: request.dataOwnerId,
    ownerGeneration: request.ownerGeneration,
  };
  requireSidebarStoreAccess();
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        requireSidebarStoreAccess({ rejectSnapshotChange: true });
        const nextOrder = applyPinnedMutation(
          current.value.pinnedOrder,
          mutation,
          hasAuthoritativePinnedOrder(current.customizedKeys),
        );
        changed = !sameStringArray(current.value.pinnedOrder, nextOrder);
        return { pinnedOrder: nextOrder };
      }, SIDEBAR_WRITE_OPTIONS),
    );
    assertScopeCurrent(scopeKey);
  } catch (err) {
    if (isIpcError(err)) throw err;
    if (activeOwnerScopeKey() !== scopeKey || isAppSessionBoundaryPending()) {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
    }
    log.error('failed to persist sidebar pinned order', err);
    throwIpcError('INTERNAL', 'failed to persist sidebar settings');
  }
  if (changed) {
    broadcastPinnedOrderChanged(nextSettings.pinnedOrder, ownerStamp);
    refreshInputDeviceTaskSlotsAfterPinnedOrderChange();
  }
  return Array.from(nextSettings.pinnedOrder);
}

async function setProjectHidden(rawRequest: unknown): Promise<boolean> {
  const request = requireWriteRequest(rawRequest);
  const projectKey = requireProjectKey(request.projectKey);
  if (typeof request.hidden !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project hidden state');
  }
  const hidden = request.hidden;
  assertRequestedOwner(request);
  const scopeKey = activeOwnerScopeKey();
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: request.dataOwnerId,
    ownerGeneration: request.ownerGeneration,
  };
  requireSidebarStoreAccess();
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        requireSidebarStoreAccess({ rejectSnapshotChange: true });
        const currentKeys = current.value.hiddenProjectKeys;
        const comparisonKey = projectKeyComparisonKey(projectKey, process.platform) ?? projectKey;
        const alreadyHidden = currentKeys.some(
          (entry) => projectKeyComparisonKey(entry, process.platform) === comparisonKey,
        );
        if (alreadyHidden === hidden) return { hiddenProjectKeys: currentKeys };
        if (hidden && currentKeys.length >= MAX_HIDDEN_PROJECT_ENTRIES) {
          throwIpcError('INVALID_PARAMS', 'too many hidden sidebar projects');
        }
        changed = true;
        return {
          hiddenProjectKeys: hidden
            ? [...currentKeys, projectKey]
            : currentKeys.filter(
                (entry) => projectKeyComparisonKey(entry, process.platform) !== comparisonKey,
              ),
        };
      }, SIDEBAR_WRITE_OPTIONS),
    );
    assertScopeCurrent(scopeKey);
  } catch (err) {
    if (isIpcError(err)) throw err;
    if (activeOwnerScopeKey() !== scopeKey || isAppSessionBoundaryPending()) {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
    }
    log.error('failed to persist hidden sidebar projects', err);
    throwIpcError('INTERNAL', 'failed to persist sidebar settings');
  }
  if (changed) {
    broadcastHiddenProjectKeysChanged(nextSettings.hiddenProjectKeys, ownerStamp);
  }
  return changed;
}

/** Persist one plugin main-view visibility override in Main's owner-scoped store. */
async function setMainViewHidden(rawRequest: unknown): Promise<string[]> {
  const request = requireWriteRequest(rawRequest);
  const ghostId = requireGhostId(request.ghostId);
  if (typeof request.hidden !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid main-view hidden state');
  }
  const hidden = request.hidden;
  assertRequestedOwner(request);
  const scopeKey = activeOwnerScopeKey();
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: request.dataOwnerId,
    ownerGeneration: request.ownerGeneration,
  };
  requireSidebarStoreAccess();
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        requireSidebarStoreAccess({ rejectSnapshotChange: true });
        const currentIds = current.value.hiddenMainViewGhostIds;
        const alreadyHidden = currentIds.includes(ghostId);
        if (alreadyHidden === hidden) return { hiddenMainViewGhostIds: currentIds };
        if (hidden && currentIds.length >= SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES) {
          throwIpcError('INVALID_PARAMS', 'too many hidden main-view plugins');
        }
        changed = true;
        return {
          hiddenMainViewGhostIds: hidden
            ? [...currentIds, ghostId]
            : currentIds.filter((entry) => entry !== ghostId),
        };
      }, SIDEBAR_WRITE_OPTIONS),
    );
    assertScopeCurrent(scopeKey);
  } catch (err) {
    if (isIpcError(err)) throw err;
    if (activeOwnerScopeKey() !== scopeKey || isAppSessionBoundaryPending()) {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during sidebar mutation');
    }
    log.error('failed to persist hidden main-view plugins', err);
    throwIpcError('INTERNAL', 'failed to persist sidebar settings');
  }
  if (changed) {
    broadcastHiddenMainViewGhostIdsChanged(nextSettings.hiddenMainViewGhostIds, ownerStamp);
  }
  return Array.from(nextSettings.hiddenMainViewGhostIds);
}

type SidebarPathState = 'missing' | 'regular-file' | 'blocked';

function sidebarPathState(file: string): SidebarPathState {
  try {
    return fs.lstatSync(file).isFile() ? 'regular-file' : 'blocked';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'blocked';
  }

  // A leftover atomic-write backup can be the only recoverable snapshot.
  // Never create a different authority while it remains unresolved.
  try {
    fs.lstatSync(`${file}.bak`);
    return 'blocked';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'blocked';
  }
}

function scopedSidebarPathState(file: string): SidebarPathState {
  return sidebarPathState(file);
}

interface LegacyRendererOwnerMarker {
  version: 1;
  ownerKey: string;
  pinnedLegacyConsumed: boolean;
}

type LegacyRendererOwnerMarkerState =
  { kind: 'missing' | 'blocked' } | { kind: 'valid'; marker: LegacyRendererOwnerMarker };

function boundedMarkerPathState(file: string): SidebarPathState {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= MAX_LEGACY_RENDERER_OWNER_MARKER_BYTES
      ? 'regular-file'
      : 'blocked';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'blocked';
  }
}

function readLegacyRendererOwnerMarker(
  markerPath: string,
  recoverBackup: boolean,
): LegacyRendererOwnerMarkerState {
  try {
    const primaryState = boundedMarkerPathState(markerPath);
    if (primaryState === 'blocked') return { kind: 'blocked' };
    let readPath = markerPath;
    if (primaryState === 'missing') {
      readPath = `${markerPath}.bak`;
      const backupState = boundedMarkerPathState(readPath);
      if (backupState === 'blocked') return { kind: 'blocked' };
      if (backupState === 'missing') return { kind: 'missing' };
    }

    const raw = recoverBackup
      ? readAtomicFileSync(markerPath)
      : fs.readFileSync(readPath, 'utf-8');
    if (raw === null) return { kind: 'missing' };
    if (Buffer.byteLength(raw, 'utf-8') > MAX_LEGACY_RENDERER_OWNER_MARKER_BYTES) {
      return { kind: 'blocked' };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { ownerKey?: unknown }).ownerKey !== 'string' ||
      typeof (parsed as { pinnedLegacyConsumed?: unknown }).pinnedLegacyConsumed !== 'boolean'
    ) {
      return { kind: 'blocked' };
    }
    return { kind: 'valid', marker: parsed as LegacyRendererOwnerMarker };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'blocked' };
  }
}

function currentPinnedOrderIsAuthoritative(): boolean {
  try {
    return readCurrentSettings().pinnedOrderIsAuthoritative;
  } catch {
    return false;
  }
}

/**
 * Atomically picks the only owner allowed to consume the shared Renderer
 * localStorage namespace. The marker contains only the opaque owner key; the
 * legacy values remain in Renderer storage until its envelope commit succeeds.
 */
function claimLegacyRendererSidebarOwner(): SidebarLegacyRendererOwnerClaim {
  const stamp = getActiveDataOwnerPushStamp();
  if (!stamp.dataOwnerId || isAppSessionBoundaryPending()) {
    return { ...stamp, claimed: false, canInitialize: false, pinnedLegacyConsumed: false };
  }

  const ownerKey = dataOwnerStorageKey(stamp.dataOwnerId);
  const markerPath = path.join(app.getPath('userData'), LEGACY_RENDERER_OWNER_MARKER_FILE);
  const exclusiveAtStart = hasExclusiveSharedLegacyUserDataAccess();
  // Existing immutable envelopes remain readable without exclusivity. In that
  // mode inspect the primary or backup in place: restoring a backup would
  // mutate the shared profile while another build may still own it.
  let state = readLegacyRendererOwnerMarker(markerPath, exclusiveAtStart);
  if (state.kind === 'missing' && exclusiveAtStart) {
    const temporaryPath = `${markerPath}.init-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const marker: LegacyRendererOwnerMarker = {
        version: 1,
        ownerKey,
        pinnedLegacyConsumed: currentPinnedOrderIsAuthoritative(),
      };
      fs.writeFileSync(temporaryPath, JSON.stringify(marker), {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      fs.linkSync(temporaryPath, markerPath);
      log.info('legacy Renderer sidebar owner claimed', { ownerKey });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn('failed to claim legacy Renderer sidebar owner', {
          ownerKey,
          errorCode: sidebarSettingsErrorCode(err),
        });
      }
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary marker is never authoritative until its hard link exists.
      }
    }
    state = readLegacyRendererOwnerMarker(markerPath, true);
  }

  if (state.kind !== 'valid' || state.marker.ownerKey !== ownerKey) {
    return { ...stamp, claimed: false, canInitialize: false, pinnedLegacyConsumed: false };
  }

  if (
    exclusiveAtStart &&
    !state.marker.pinnedLegacyConsumed &&
    currentPinnedOrderIsAuthoritative()
  ) {
    try {
      atomicWriteFileSync(
        markerPath,
        JSON.stringify({ ...state.marker, pinnedLegacyConsumed: true }),
      );
      state = readLegacyRendererOwnerMarker(markerPath, true);
    } catch (err) {
      log.warn('failed to record consumed legacy Renderer pins', {
        ownerKey,
        errorCode: sidebarSettingsErrorCode(err),
      });
    }
  }

  const marker = state.kind === 'valid' && state.marker.ownerKey === ownerKey ? state.marker : null;
  return {
    ...stamp,
    claimed: marker !== null,
    canInitialize:
      marker !== null && exclusiveAtStart && hasExclusiveSharedLegacyUserDataAccess(),
    pinnedLegacyConsumed: marker?.pinnedLegacyConsumed === true,
  };
}

type LegacySidebarClaimResult = 'blocked' | 'ready' | 'snapshot-changed';

function initializeScopedSidebarSettings(
  scopedPath: string,
  ownerKey: string,
  legacyPath?: string,
): LegacySidebarClaimResult {
  const initialContents = legacyPath ? readReadableSidebarSettingsFile(legacyPath) : '{}';
  if (initialContents === null) {
    log.warn('failed to initialize sidebar settings owner namespace', {
      ownerKey,
      errorCode: 'INVALID_SETTINGS',
    });
    return 'blocked';
  }

  const temporaryPath = `${scopedPath}.init-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    // Preserve a root file as the parent release's compatibility state. The
    // scoped snapshot is the current release's immutable first-upgrade input;
    // later ownerless root writes are intentionally not re-imported. When no
    // root exists, an empty object is the durable "legacy checked" bit while
    // still allowing Renderer localStorage pins to perform their own migration.
    fs.writeFileSync(temporaryPath, initialContents, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    // Linking a fully written same-directory temporary file publishes it
    // atomically without overwriting a snapshot created by another process.
    fs.linkSync(temporaryPath, scopedPath);
    log.info(
      legacyPath
        ? 'legacy sidebar settings copied into owner namespace'
        : 'sidebar settings owner namespace initialized',
      { ownerKey },
    );
    return 'snapshot-changed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return readReadableSidebarSettingsFile(scopedPath) !== null ? 'snapshot-changed' : 'blocked';
    }
    log.warn('failed to initialize sidebar settings owner namespace', {
      ownerKey,
      errorCode: sidebarSettingsErrorCode(err),
    });
    return 'blocked';
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file is never authoritative until its hard link exists.
    }
  }
}

function readReadableSidebarSettingsFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    if (Buffer.byteLength(raw, 'utf-8') > MAX_SETTINGS_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? raw : null;
  } catch {
    return null;
  }
}

function claimLegacySidebarSettingsResult(): LegacySidebarClaimResult {
  const session = getActiveAppSession();
  if (session.mode !== 'cloud' || !session.dataOwnerId) return 'blocked';

  const root = app.getPath('userData');
  const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
  const legacyPath = path.join(root, SETTINGS_FILE_NAME);
  const scopedPath = ownerScopedUserDataPath(SETTINGS_FILE_NAME);

  if (isLegacyOwnerNamespaceClaimedByOtherOwner(session.dataOwnerId)) return 'ready';
  if (
    !isLegacyOwnerNamespaceClaimOwnedBy(session.dataOwnerId) ||
    !hasExclusiveSharedLegacyUserDataAccess()
  ) {
    return 'blocked';
  }

  const legacyPathState = sidebarPathState(legacyPath);
  if (legacyPathState === 'missing') {
    return initializeScopedSidebarSettings(scopedPath, ownerKey);
  }
  if (legacyPathState === 'blocked') return 'blocked';
  return initializeScopedSidebarSettings(scopedPath, ownerKey, legacyPath);
}

function refreshInputDeviceTaskSlotsAfterPinnedOrderChange(): void {
  void resumeInputDeviceTaskSlots().catch((error: unknown) => {
    log.warn('Input device task slot refresh failed after pinned-order change', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function registerSidebarSettingsIpc(): void {
  ipcMain.on('sidebar-settings:claim-renderer-legacy-owner-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = claimLegacyRendererSidebarOwner();
  });
  ipcMain.on('sidebar-settings:load-snapshot-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = loadSidebarSettingsSnapshot();
  });
  ipcMain.handle('sidebar-settings:save-pinned-order', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return savePinnedOrder(request as SidebarPinnedOrderWriteRequest);
  });
  ipcMain.handle('sidebar-settings:set-project-hidden', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return setProjectHidden(request as SidebarProjectHiddenWriteRequest);
  });
  ipcMain.handle('sidebar-settings:set-main-view-hidden', (event, request) => {
    assertTrustedAppRendererEvent(event);
    return setMainViewHidden(request as SidebarMainViewHiddenWriteRequest);
  });
}

export const __testing = {
  normalizeSettings,
  MAX_SETTINGS_BYTES,
  LEGACY_RENDERER_OWNER_MARKER_FILE,
  MAX_LEGACY_RENDERER_OWNER_MARKER_BYTES,
  SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES,
  pendingWriteChainCount: () => writeChains.size,
};
