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
import type {
  SidebarPinnedOrderMutation,
  SidebarPinnedOrderWriteRequest,
  SidebarProjectHiddenWriteRequest,
  SidebarSettingsSnapshot,
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
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { hasLegacyOwnerNamespaceClaim } from './ownerNamespaceMigration.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface SidebarSettingsShape {
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
}

const DEFAULTS: SidebarSettingsShape = { pinnedOrder: [], hiddenProjectKeys: [] };
const MAX_PINNED_ORDER_ENTRIES = 10_000;
const MAX_PINNED_ORDER_ENTRY_LENGTH = 4_096;
const MAX_HIDDEN_PROJECT_ENTRIES = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;
const MAX_SETTINGS_BYTES = 64 * 1024 * 1024;
const SETTINGS_FILE_NAME = 'sidebar-settings.json';
const LEGACY_OWNER_MARKER = 'sidebar-settings-legacy-owner.v1.json';

const log = createLogger('sidebar-settings');
const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<SidebarSettingsShape>>
>();
const writeChains = new Map<string, Promise<unknown>>();

function normalizePinnedOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_PINNED_ORDER_ENTRY_LENGTH ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
    if (normalized.length >= MAX_PINNED_ORDER_ENTRIES) break;
  }
  return normalized;
}

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
    pinnedOrder: normalizePinnedOrder(value.pinnedOrder),
    hiddenProjectKeys: normalizeHiddenProjectKeys(value.hiddenProjectKeys),
  };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function currentStore() {
  const session = getActiveAppSession();
  if (!session.dataOwnerId) {
    throwIpcError('PRECONDITION_FAILED', 'sidebar settings require an active data owner');
  }
  claimLegacySidebarSettings();
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
    });
    stores.set(ownerRoot, store);
  }
  return store;
}

function readCurrentSettings(): SidebarSettingsShape {
  if (!getActiveAppSession().dataOwnerId) return { ...DEFAULTS };
  const store = currentStore();
  store.invalidateIfChanged();
  return store.read();
}

export function loadSidebarSettingsSnapshot(): SidebarSettingsSnapshot {
  const stamp = getActiveDataOwnerPushStamp();
  const settings = stamp.dataOwnerId ? readCurrentSettings() : DEFAULTS;
  return {
    ...stamp,
    pinnedOrder: Array.from(settings.pinnedOrder),
    hiddenProjectKeys: Array.from(settings.hiddenProjectKeys),
  };
}

function requirePinnedOrder(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_PINNED_ORDER_ENTRIES ||
    raw.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.length > MAX_PINNED_ORDER_ENTRY_LENGTH,
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
    raw.length > MAX_PINNED_ORDER_ENTRY_LENGTH
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

  return normalizePinnedOrder(result);
}

function applyPinnedMutation(
  current: readonly string[],
  mutation: SidebarPinnedOrderMutation,
): string[] {
  switch (mutation.kind) {
    case 'promote':
      return current[0] === mutation.entryId
        ? Array.from(current)
        : [mutation.entryId, ...current.filter((entry) => entry !== mutation.entryId)];
    case 'remove':
      return current.filter((entry) => entry !== mutation.entryId);
    case 'migrate-legacy':
      return current.length === 0 ? Array.from(mutation.order) : Array.from(current);
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
  writeChains.set(
    scopeKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
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
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        const nextOrder = applyPinnedMutation(current.value.pinnedOrder, mutation);
        changed = !sameStringArray(current.value.pinnedOrder, nextOrder);
        return changed ? { pinnedOrder: nextOrder } : {};
      }),
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
  const store = currentStore();
  let changed = false;
  let nextSettings: SidebarSettingsShape;
  try {
    nextSettings = await enqueueWrite(scopeKey, () =>
      store.updateAtomic((current) => {
        const currentKeys = current.value.hiddenProjectKeys;
        const comparisonKey = projectKeyComparisonKey(projectKey, process.platform) ?? projectKey;
        const alreadyHidden = currentKeys.some(
          (entry) => projectKeyComparisonKey(entry, process.platform) === comparisonKey,
        );
        if (alreadyHidden === hidden) return {};
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
      }),
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

function readLegacyOwnerKey(markerPath: string): string | null | undefined {
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as {
      version?: unknown;
      ownerKey?: unknown;
    };
    return parsed.version === 1 && typeof parsed.ownerKey === 'string' && parsed.ownerKey.length > 0
      ? parsed.ownerKey
      : null;
  } catch (err) {
    log.warn('invalid sidebar legacy owner marker; refusing legacy migration', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Backfills users whose global owner migration completed before sidebar state was included. */
export function claimLegacySidebarSettings(): boolean {
  const session = getActiveAppSession();
  if (session.mode !== 'cloud' || !session.dataOwnerId) return false;
  if (!hasLegacyOwnerNamespaceClaim(session.dataOwnerId)) return false;

  const root = app.getPath('userData');
  const markerPath = path.join(root, LEGACY_OWNER_MARKER);
  const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
  const existing = readLegacyOwnerKey(markerPath);
  if (existing !== undefined && existing !== ownerKey) return false;
  if (existing === undefined) {
    try {
      fs.writeFileSync(markerPath, JSON.stringify({ version: 1, ownerKey }, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn('failed to claim legacy sidebar settings', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      if (readLegacyOwnerKey(markerPath) !== ownerKey) return false;
    }
  }

  const legacyPath = path.join(root, SETTINGS_FILE_NAME);
  const scopedPath = ownerScopedUserDataPath(SETTINGS_FILE_NAME);
  if (!fs.existsSync(legacyPath) || fs.existsSync(scopedPath)) return true;
  try {
    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    fs.renameSync(legacyPath, scopedPath);
    log.info('legacy sidebar settings moved into owner namespace', { ownerKey });
    return true;
  } catch (err) {
    log.warn('failed to migrate legacy sidebar settings', {
      ownerKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
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
  LEGACY_OWNER_MARKER,
};
