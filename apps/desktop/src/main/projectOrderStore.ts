/**
 * Owner-scoped project-order snapshot.
 *
 * Source of truth for "按项目手动排序" lives on the controlled desktop so
 * phones and other desktops remoting into this machine share one order.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';

import {
  hostLocalProjectKeysOnly,
  parseSyncedProjectOrderMode,
} from '@cindy/maker-shared/project-order-sync';
import type { SyncedProjectOrderSnapshot } from '../shared/projectOrderSettings.js';
import {
  SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
  SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
  SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL,
} from '../shared/projectOrderSettings.js';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import { isDeviceLinkInvoke } from './device-link/invoke-context.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createLogger } from './logger.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface ProjectOrderShape {
  manualProjectOrder: string[];
  projectOrder: 'activity' | 'custom';
}

const DEFAULTS: ProjectOrderShape = {
  manualProjectOrder: [],
  projectOrder: 'activity',
};
const FILE_NAME = 'project-order.json';
const MAX_BYTES = 1024 * 1024;
const log = createLogger('project-order');
const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<ProjectOrderShape>>>();

function normalizeSettings(raw: unknown): ProjectOrderShape {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    manualProjectOrder: hostLocalProjectKeysOnly(value.manualProjectOrder)
      .filter((key) => key.length <= 4096),
    projectOrder: parseSyncedProjectOrderMode(value.projectOrder),
  };
}

function currentStore() {
  const session = getActiveAppSession();
  if (!session.dataOwnerId) {
    throwIpcError('PRECONDITION_FAILED', 'project order requires an active data owner');
  }
  const ownerRoot = ownerScopedUserDataPath();
  let store = stores.get(ownerRoot);
  if (!store) {
    store = createOverrideSettingsFile<ProjectOrderShape>({
      filePath: () => path.join(ownerRoot, FILE_NAME),
      defaults: DEFAULTS,
      normalize: normalizeSettings,
      log,
      label: 'project-order',
      scopeKey: activeOwnerScopeKey,
      maxBytes: MAX_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
    });
    stores.set(ownerRoot, store);
  }
  return store;
}

function toSnapshot(
  authoritative: boolean,
  settings: ProjectOrderShape,
  ownerStamp?: DataOwnerPushStamp,
): SyncedProjectOrderSnapshot {
  return {
    authoritative,
    available: true,
    manualProjectOrder: Array.from(settings.manualProjectOrder),
    projectOrder: settings.projectOrder,
    ...(ownerStamp ? { ownerStamp } : {}),
  };
}

function assertRequestedOwner(request: DataOwnerPushStamp): void {
  const current = getActiveDataOwnerPushStamp();
  if (
    isAppSessionBoundaryPending()
    || !current.dataOwnerId
    || current.dataOwnerId !== request.dataOwnerId
    || current.ownerGeneration !== request.ownerGeneration
  ) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during project order mutation');
  }
}

function parseApplyRequest(raw: unknown): {
  manualProjectOrder: unknown;
  projectOrder: unknown;
} & DataOwnerPushStamp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isDataOwnerPushStamp(raw)) {
    throwIpcError('INVALID_PARAMS', 'invalid project order owner stamp');
  }
  return raw as { manualProjectOrder: unknown; projectOrder: unknown } & DataOwnerPushStamp;
}

function notifyChanged(snapshot: SyncedProjectOrderSnapshot, ownerStamp: DataOwnerPushStamp): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isAppContentWindow(window)) continue;
    window.webContents.send(SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL, snapshot, ownerStamp);
  }
  tapWindowBroadcast(SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL, snapshot, ownerStamp);
}

function readSnapshot(): SyncedProjectOrderSnapshot {
  const stamp = getActiveDataOwnerPushStamp();
  if (!stamp.dataOwnerId || isAppSessionBoundaryPending()) return toSnapshot(false, DEFAULTS);
  try {
    const store = currentStore();
    store.invalidateIfChanged();
    const state = store.readState();
    const authoritative = state.customizedKeys.includes('projectOrder')
      || state.customizedKeys.includes('manualProjectOrder');
    return toSnapshot(authoritative, state.value, stamp);
  } catch (error) {
    log.warn('project order read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toSnapshot(false, DEFAULTS);
  }
}

function applySnapshot(raw: unknown): SyncedProjectOrderSnapshot {
  const request = parseApplyRequest(raw);
  assertRequestedOwner(request);
  const scopeKey = activeOwnerScopeKey();
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: request.dataOwnerId,
    ownerGeneration: request.ownerGeneration,
  };
  const next = normalizeSettings({
    manualProjectOrder: request.manualProjectOrder,
    projectOrder: request.projectOrder,
  });
  const store = currentStore();
  store.writePatch(next, { preserveDefaults: true });
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
    throwIpcError('PRECONDITION_FAILED', 'active account changed during project order mutation');
  }
  const snapshot = toSnapshot(true, next, ownerStamp);
  notifyChanged(snapshot, ownerStamp);
  return snapshot;
}

function assertOrigin(event: IpcMainInvokeEvent): void {
  if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
}

export function registerProjectOrderIpc(): void {
  ipcMain.handle(SIDEBAR_GET_PROJECT_ORDER_CHANNEL, (event) => {
    assertOrigin(event);
    return readSnapshot();
  });
  ipcMain.handle(SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL, (event, request) => {
    assertOrigin(event);
    return applySnapshot(request);
  });
}

export const __testing = {
  applySnapshot,
  normalizeSettings,
  readSnapshot,
};
