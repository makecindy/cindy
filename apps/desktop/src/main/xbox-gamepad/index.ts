import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { createLogger } from '../logger.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { registerInputDevice } from '../input-devices/registry.js';
import { isSecondaryAppWindow } from '../secondary-windows.js';
import { isAppContentWindow } from '../windowFocusClassifier.js';
import {
  WORKLOUDER_CODEX_ACTION_CHANNEL,
  type WorkLouderCodexRendererAction,
} from '../../shared/workLouderCodex.js';
import {
  XBOX_GAMEPAD_DEVICE,
  XBOX_GAMEPAD_GET_STATE_CHANNEL,
  XBOX_GAMEPAD_PREVIEW_INPUT_CHANNEL,
  XBOX_GAMEPAD_PROBE_CHANNEL,
  XBOX_GAMEPAD_RESET_SETTINGS_CHANNEL,
  XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL,
  XBOX_GAMEPAD_SET_SETTINGS_CHANNEL,
  XBOX_GAMEPAD_STATE_CHANGED_CHANNEL,
  type XboxGamepadPreviewInput,
  type XboxGamepadState,
} from '../../shared/xboxGamepad.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { createWorkLouderCodexActiveWindowRouter } from '../worklouder-codex/actionWindow.js';
import { XboxGamepadController } from './controller.js';
import { createXboxGamepadHost } from './host.js';
import { createLayoutPreviewLease, layoutPreviewOwnerFromEvent } from '../input-devices/previewLease.js';
import { createXboxGamepadSettingsIpc } from './settingsIpc.js';
import {
  readXboxGamepadSettings,
  resetXboxGamepadSettings,
  writeXboxGamepadSettingsPatch,
} from './settingsStore.js';

const log = createLogger('xbox-gamepad');

const actionWindowRouter = createWorkLouderCodexActiveWindowRouter({
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getMainWindow: getDeepLinkMainWindow,
  isActionWindow: (win) => {
    if (!win) return false;
    const main = getDeepLinkMainWindow();
    return win === main || isSecondaryAppWindow(win);
  },
});

function isCindyFrontmost(): boolean {
  return isAppContentWindow(BrowserWindow.getFocusedWindow());
}

function sendWindowMessage(win: BrowserWindow, channel: string, payload: unknown): boolean {
  if (win.webContents.isDestroyed() || win.webContents.isLoading()) return false;
  win.webContents.send(channel, payload);
  return true;
}

function dispatchRendererAction(action: WorkLouderCodexRendererAction): void {
  if (action.type === 'external-url') {
    void shell.openExternal(action.url).catch((error: unknown) => {
      log.warn('failed to open Xbox gamepad external action', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const win = actionWindowRouter.resolve(action);
  if (win && sendWindowMessage(win, WORKLOUDER_CODEX_ACTION_CHANNEL, action)) return;
  log.debug('Xbox gamepad action skipped because Cindy is not the frontmost app', {
    type: action.type,
  });
}

function broadcastState(state: XboxGamepadState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    window.webContents.send(XBOX_GAMEPAD_STATE_CHANGED_CHANNEL, state);
  }
}

function broadcastPreview(input: XboxGamepadPreviewInput): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    window.webContents.send(XBOX_GAMEPAD_PREVIEW_INPUT_CHANNEL, input);
  }
}

const controller = new XboxGamepadController({
  isCindyFrontmost,
  dispatch: dispatchRendererAction,
  preview: broadcastPreview,
});

const host = createXboxGamepadHost((message) => {
  controller.handleHostMessage(message);
});
const layoutPreviewLease = createLayoutPreviewLease((active) => {
  controller.setLayoutPreviewActive(active);
});

let inputDeviceRegistered = false;
let settingsIpcRegistered = false;
let focusHooksInstalled = false;

export function registerXboxGamepadInputDevice(): void {
  if (inputDeviceRegistered) return;
  inputDeviceRegistered = true;
  registerInputDevice({
    descriptor: XBOX_GAMEPAD_DEVICE,
    start: () => {
      registerXboxGamepadSettingsIpc();
    },
    updateSessionActivity: () => undefined,
    resumeTaskSlots: async () => {
      controller.applySettings(readXboxGamepadSettings());
    },
    suspendTaskSlots: () => {
      controller.applySettings({ ...readXboxGamepadSettings(), deviceEnabled: false });
    },
    dispose: async () => {
      host.stop();
    },
  });
}

export function registerXboxGamepadSettingsIpc(): void {
  if (settingsIpcRegistered) return;
  settingsIpcRegistered = true;
  controller.applySettings(readXboxGamepadSettings());
  if (process.platform === 'darwin') host.start();
  else controller.markUnavailable();
  installFocusHooks();

  const handlers = createXboxGamepadSettingsIpc({
    assertTrustedSender: (event) => assertTrustedAppRendererEvent(event as never),
    getState: () => controller.getState(),
    writeSettings: writeXboxGamepadSettingsPatch,
    resetSettings: resetXboxGamepadSettings,
    applySettings: (settings) => controller.applySettings(settings),
    probeDevice: () => host.probe(),
    setLayoutPreviewActive: (active, event) => {
      layoutPreviewLease.setActive(active, layoutPreviewOwnerFromEvent(event));
    },
  });

  ipcMain.handle(XBOX_GAMEPAD_GET_STATE_CHANNEL, (event) => handlers.get(event));
  ipcMain.handle(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, (event, patch: unknown) =>
    handlers.set(event, patch),
  );
  ipcMain.handle(XBOX_GAMEPAD_RESET_SETTINGS_CHANNEL, (event) => handlers.reset(event));
  ipcMain.handle(XBOX_GAMEPAD_PROBE_CHANNEL, (event) => handlers.probe(event));
  ipcMain.handle(XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL, (event, active: unknown) =>
    handlers.setLayoutPreviewActive(event, active),
  );

  controller.subscribe((state) => {
    broadcastState(state);
  });
}

function installFocusHooks(): void {
  if (focusHooksInstalled) return;
  focusHooksInstalled = true;
  const sync = (): void => {
    controller.setCindyFrontmost(isCindyFrontmost());
  };
  app.on('browser-window-focus', sync);
  app.on('browser-window-blur', sync);
}
