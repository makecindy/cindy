/**
 * Owner-scoped sidebar identity state.
 *
 * The main process owns the durable snapshot and binds every mutation and
 * broadcast to the account generation that initiated it. Renderer windows
 * only keep optimistic mirrors.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import { isIpcError } from '../shared/ipc-errors.js';
import { normalizeProjectKey, projectKeyComparisonKey } from '../shared/projectKeys.js';
import {
  normalizeSidebarPinnedOrder,
  SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH,
  SIDEBAR_PINNED_ORDER_MAX_ENTRIES,
  type SidebarPinnedOrderMutation,
  type SidebarPinnedOrderWriteRequest,
  type SidebarProjectHiddenWriteRequest,
  type SidebarSettingsSnapshot,
} from '../shared/sidebarSettings.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createLogger } from './logger.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import {
  hasLegacyOwnerNamespaceClaim,
  isLegacyOwnerNamespaceClaimedByOtherOwner,
} from './ownerNamespaceMigration.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface SidebarSettingsShape {
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
}

const DEFAULTS: SidebarSettingsShape = { pinnedOrder: [], hiddenProjectKeys: [] };
const MAX_HIDDEN_PROJECT_ENTRIES = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const SETTINGS_FILE_NAME = 'sidebar-settings.json';
// An explicit empty snapshot must remain durable after the user clears the list.
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

function normalizeSettings(raw: unknown): SidebarSettingsShape {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    pinnedOrder: normalizeSidebarPinnedOrder(value.pinnedOrder),
    hiddenProjectKeys: normalizeHiddenProjectKeys(value.hiddenProjectKeys),
  };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type SidebarPathState = 'missing' | 'regular-file' | 'blocked';

function sidebarPathState(file: string): SidebarPathState {
  try {
    const primary = fs.lstatSync(file);
    return primary.isFile() ? 'regular-file' : 'blocked';
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

type SidebarStoreAccessResult = { status: 'blocked' } | { status: 'ready'; filePath: string };

function sidebarStoreAccessResult(): SidebarStoreAccessResult {
  const session = getActiveAppSession();
  if (!session.dataOwnerId) return { status: 'blocked' };
  if (session.mode !== 'local' && session.mode !== 'cloud') return { status: 'blocked' };

  const scopedPath = ownerScopedUserDataPath(SETTINGS_FILE_NAME);
  if (session.mode === 'local') {
    return sidebarPathState(scopedPath) === 'blocked'
      ? { status: 'blocked' }
      : { status: 'ready', filePath: scopedPath };
  }

  // The immutable global claim assigns the pre-owner file to exactly one
  // verified cloud owner. Keep that owner's file at the legacy path so the
  // parent release and this release always read and write the same snapshot
  // across downgrade/re-upgrade. Other owners never inspect or consume it.
  if (isLegacyOwnerNamespaceClaimedByOtherOwner(session.dataOwnerId)) {
    return sidebarPathState(scopedPath) === 'blocked'
      ? { status: 'blocked' }
      : { status: 'ready', filePath: scopedPath };
  }
  // Keep the fixed root route closed until the global claim is complete and
  // this process is exclusive. We no longer move this file, but an older live
  // process still writes it without the current cross-process lock.
  if (!hasLegacyOwnerNamespaceClaim(session.dataOwnerId)) {
    return { status: 'blocked' };
  }

  const legacyPath = path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
  const legacyState = sidebarPathState(legacyPath);
  if (legacyState === 'blocked') return { status: 'blocked' };
  return { status: 'ready', filePath: legacyPath };
}

function requireSidebarStorePath(): string {
  const result = sidebarStoreAccessResult();
  if (result.status === 'blocked') {
    throwIpcError('PRECONDITION_FAILED', 'sidebar settings owner claim is pending');
  }
  return result.filePath;
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
      filePath: requireSidebarStorePath,
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
  if (accessResult.status === 'blocked') {
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

async function savePinnedOrder(rawRequest: unknown): Promise<string[]> {
  const request = requireWriteRequest(rawRequest);
  const mutation = requirePinnedMutation(request.mutation);
  assertRequestedOwner(request);
  const scopeKey = activeOwnerScopeKey();
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: request.dataOwnerId,
    ownerGeneration: request.ownerGeneration,
  };
  requireSidebarStorePath();
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        requireSidebarStorePath();
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
  requireSidebarStorePath();
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        requireSidebarStorePath();
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

export function registerSidebarSettingsIpc(): void {
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
}

export const __testing = {
  normalizeSettings,
  MAX_SETTINGS_BYTES,
  pendingWriteChainCount: () => writeChains.size,
};
