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
  GAMEPAD_DEVICES,
  GAMEPAD_FAMILIES,
  XBOX_GAMEPAD_GET_STATE_CHANNEL,
  XBOX_GAMEPAD_PREVIEW_INPUT_CHANNEL,
  XBOX_GAMEPAD_PROBE_CHANNEL,
  XBOX_GAMEPAD_RESET_SETTINGS_CHANNEL,
  XBOX_GAMEPAD_SET_LAYOUT_PREVIEW_CHANNEL,
  XBOX_GAMEPAD_SET_SETTINGS_CHANNEL,
  XBOX_GAMEPAD_STATE_CHANGED_CHANNEL,
  type GamepadAccessoriesState,
  type GamepadFamily,
  type XboxGamepadPreviewInput,
} from '../../shared/xboxGamepad.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import { createWorkLouderCodexActiveWindowRouter } from '../worklouder-codex/actionWindow.js';
import { XboxGamepadController } from './controller.js';
import { createXboxGamepadHost } from './host.js';
import {
  createLayoutPreviewLease,
  layoutPreviewOwnerFromEvent,
} from '../input-devices/previewLease.js';
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

function broadcastState(state: GamepadAccessoriesState): void {
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
let previewFamily: GamepadFamily | null = null;
const layoutPreviewLease = createLayoutPreviewLease((active) => {
  if (!active) previewFamily = null;
  controller.setLayoutPreviewActive(active, active ? previewFamily : null);
  syncSwitch2Usb();
});

function syncSwitch2Usb(): void {
  host.setSwitch2UsbWanted(
    controller.getAccessories().nintendo.settings.deviceEnabled || previewFamily === 'nintendo',
  );
}

let inputDeviceRegistered = false;
let settingsIpcRegistered = false;
let focusHooksInstalled = false;

export function registerXboxGamepadInputDevice(): void {
  if (inputDeviceRegistered) return;
  inputDeviceRegistered = true;
  for (const family of GAMEPAD_FAMILIES) {
    registerInputDevice({
      descriptor: GAMEPAD_DEVICES[family],
      start: () => {
        registerXboxGamepadSettingsIpc();
      },
      updateSessionActivity: () => undefined,
      resumeTaskSlots: async () => {
        controller.applySettings(family, readXboxGamepadSettings(family));
        syncSwitch2Usb();
      },
      suspendTaskSlots: () => {
        controller.applySettings(family, {
          ...readXboxGamepadSettings(family),
          deviceEnabled: false,
        });
        syncSwitch2Usb();
      },
      dispose: async () => {
        host.stop();
      },
    });
  }
}

export function registerXboxGamepadSettingsIpc(): void {
  if (settingsIpcRegistered) return;
  settingsIpcRegistered = true;
  for (const family of GAMEPAD_FAMILIES) {
    controller.applySettings(family, readXboxGamepadSettings(family));
  }
  if (process.platform === 'darwin') {
    host.start();
    syncSwitch2Usb();
  } else {
    controller.markUnavailable();
  }
  installFocusHooks();

  const handlers = createXboxGamepadSettingsIpc({
    assertTrustedSender: (event) => assertTrustedAppRendererEvent(event as never),
    getState: () => controller.getAccessories(),
    writeSettings: writeXboxGamepadSettingsPatch,
    resetSettings: resetXboxGamepadSettings,
    applySettings: (family, settings) => {
      controller.applySettings(family, settings);
      syncSwitch2Usb();
    },
    probeDevice: () => host.probe(),
    setLayoutPreviewActive: (active, family, event) => {
      const owner = layoutPreviewOwnerFromEvent(event);
      if (active) {
        if (!owner) return;
        previewFamily = family;
        layoutPreviewLease.setActive(true, owner);
        controller.setLayoutPreviewActive(true, family);
        syncSwitch2Usb();
        return;
      }
      layoutPreviewLease.setActive(false, owner);
    },
  });

  ipcMain.handle(XBOX_GAMEPAD_GET_STATE_CHANNEL, (event) => handlers.get(event));
  ipcMain.handle(XBOX_GAMEPAD_SET_SETTINGS_CHANNEL, (event, family: unknown, patch: unknown) =>
    handlers.set(event, family, patch),
  );
  ipcMain.handle(XBOX_GAMEPAD_RESET_SETTINGS_CHANNEL, (event, family: unknown) =>
    handlers.reset(event, family),
  );
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
