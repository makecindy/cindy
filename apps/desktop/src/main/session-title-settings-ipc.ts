/**
 * session-title-settings-ipc —— 动态任务标题开关的读写 IPC。
 *
 * 通道:session-title-settings-get / -set / -reset。
 * 写路径按 electron-security-and-process-boundaries.md 做 trusted-renderer 来源
 * 断言(带 preload 的辅助窗口不得改设置;旧 update-auto-settings 缺断言是历史债,
 * 不构成新通道豁免的理由)。
 */

import { ipcMain } from 'electron';

import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import {
  readSessionTitleSettingsState,
  resetSessionTitleSettings,
  writeDynamicTitleEnabled,
} from './session-title-settings-store.js';
import { throwIpcError } from './utils/ipcValidate.js';

interface SessionTitleSettingsWire {
  dynamicTitleEnabled: boolean;
  isCustomized: boolean;
  defaultDynamicTitleEnabled: boolean;
}

function sessionTitleSettingsWire(): SessionTitleSettingsWire {
  const state = readSessionTitleSettingsState();
  return {
    dynamicTitleEnabled: state.value.dynamicTitleEnabled,
    isCustomized: state.isCustomized,
    defaultDynamicTitleEnabled: state.defaults.dynamicTitleEnabled,
  };
}

let registered = false;

export function registerSessionTitleSettingsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('session-title-settings-get', (event) => {
    assertTrustedAppRendererEvent(event);
    return sessionTitleSettingsWire();
  });

  ipcMain.handle('session-title-settings-set', (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!payload || typeof payload !== 'object') {
      throwIpcError('INVALID_PARAMS', 'session title settings payload required');
    }
    const next = (payload as { dynamicTitleEnabled?: unknown }).dynamicTitleEnabled;
    if (typeof next !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'dynamicTitleEnabled required (boolean)');
    }
    writeDynamicTitleEnabled(next);
    return sessionTitleSettingsWire();
  });

  ipcMain.handle('session-title-settings-reset', (event) => {
    assertTrustedAppRendererEvent(event);
    resetSessionTitleSettings();
    return sessionTitleSettingsWire();
  });
}
