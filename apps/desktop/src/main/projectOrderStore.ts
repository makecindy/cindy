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
import { isDeviceLinkInvoke } from './device-link/invoke-context.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
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

function toSnapshot(authoritative: boolean, settings: ProjectOrderShape): SyncedProjectOrderSnapshot {
  return {
    authoritative,
    available: true,
    manualProjectOrder: Array.from(settings.manualProjectOrder),
    projectOrder: settings.projectOrder,
  };
}

function readSnapshot(): SyncedProjectOrderSnapshot {
  const stamp = getActiveDataOwnerPushStamp();
  if (!stamp.dataOwnerId) return toSnapshot(false, DEFAULTS);
  try {
    const store = currentStore();
    store.invalidateIfChanged();
    const state = store.readState();
    const authoritative = state.customizedKeys.includes('projectOrder')
      || state.customizedKeys.includes('manualProjectOrder');
    return toSnapshot(authoritative, state.value);
  } catch (error) {
    log.warn('project order read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toSnapshot(false, DEFAULTS);
  }
}

function applySnapshot(raw: unknown): SyncedProjectOrderSnapshot {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const next = normalizeSettings({
    manualProjectOrder: record.manualProjectOrder,
    projectOrder: record.projectOrder,
  });
  const store = currentStore();
  store.writePatch(next, { preserveDefaults: true });
  const snapshot = toSnapshot(true, next);
  const ownerStamp = getActiveDataOwnerPushStamp();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isAppContentWindow(window)) continue;
    window.webContents.send(SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL, snapshot, ownerStamp);
  }
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
