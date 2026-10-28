import {
  app,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  shell,
  globalShortcut,
  type BrowserWindow,
} from 'electron';
import path from 'node:path';
import { comboToElectronAccelerator, isGlobalAppShortcutComboUsable } from '../../shared/appShortcuts';
import {
  getAppShortcutStore,
  isAppShortcutRecordingActive,
  subscribeAppShortcutRecording,
} from '../app-shortcuts';
import {
  DEFAULT_HUD_SETTINGS,
  HUD_POINTER_REGIONS,
  type HudPointerRegion,
  normalizeHudSettings,
  parseHudPatch,
  isHudScreenQuestion,
  type HudState,
  type HudLayer,
} from '../../shared/hud';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';
import { createHudController } from './controller';
import { createHudPassThroughController } from './passThrough';
import {
  createHudWindowTracking,
  fitHudBounds,
  normalizeHudWindowState,
  type HudWindowState,
} from './windowState';

const store = createOverrideSettingsFile({
  filePath: () => path.join(app.getPath('userData'), 'hud-settings.json'),
  defaults: DEFAULT_HUD_SETTINGS,
  normalize: normalizeHudSettings,
  log: createLogger('hud'),
  label: 'hud',
  preserveUnreadableFile: true,
});
const windowLog = createLogger('hud-window');
const windowStore = createOverrideSettingsFile<HudWindowState>({
  filePath: () => path.join(app.getPath('userData'), 'hud-window.json'),
  defaults: { bounds: null },
  normalize: normalizeHudWindowState,
  log: windowLog,
  label: 'hud-window',
  preserveUnreadableFile: true,
  logLoadedValue: false,
});
const tracking = createHudWindowTracking({
  save(bounds) {
    try {
      windowStore.writePatch({ bounds });
    } catch {
      // A preference write failure must not block returning to the main window.
      windowLog.warn('Could not save HUD window bounds');
    }
  },
  changed: publish,
});
let hudWindow: BrowserWindow | null = null;
let restoreWindow: (() => void) | null = null;
let restoreFullscreen = false;
let layer: HudLayer = 1;
let windowGeneration = 0;
let enteringFullscreenTransition: Promise<void> | null = null;
let captureDisplay = '';
let wasVisible = false;
let captureWindow: BrowserWindow | null = null;
let nativeAppearance: { vibrancy: string | null; backgroundColor: string } | null = null;
/** Theme changes during HUD apply on exit, through the existing resolver. */
export function rememberHudAppearance(config: {
  vibrancy: string | null;
  backgroundColor: string;
}) {
  nativeAppearance = config;
}
function readSettings() {
  store.invalidateIfChanged();
  return store.read();
}
function publish() {
  pointer.sync();
  if (hudWindow && isTrustedAppRendererWindow(hudWindow) && !hudWindow.webContents.isDestroyed()) {
    hudWindow.webContents.send('hud:changed', state());
  }
}
const controller = createHudController({
  allowed: () => readSettings().allowScreen,
  changed: publish,
  enter() {
    const win = hudWindow;
    if (!win || win.isDestroyed()) throw new Error('HUD_INACTIVE');
    if (process.platform !== 'darwin') throw new Error('HUD_UNSUPPORTED');
    if (win.isFullScreen()) throw new Error('HUD_FULLSCREEN');
    const bounds = win.getBounds();
    const normalBounds = win.getNormalBounds();
    const minimum = win.getMinimumSize();
    const maximized = win.isMaximized();
    const alwaysOnTop = win.isAlwaysOnTop();
    const background = win.getBackgroundColor();
    restoreWindow = () => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(alwaysOnTop);
      win.setWindowButtonVisibility(true);
      win.setMinimumSize(minimum[0], minimum[1]);
      win.setBackgroundColor(background);
      if (nativeAppearance) {
        win.setVibrancy(nativeAppearance.vibrancy as 'hud' | null);
        win.setBackgroundColor(nativeAppearance.backgroundColor);
      }
      win.setBounds(normalBounds);
      if (maximized) win.maximize();
      if (restoreFullscreen) {
        restoreFullscreen = false;
        win.setFullScreen(true);
      }
    };
    if (maximized) win.unmaximize();
    win.setMinimumSize(420, 280);
    win.setWindowButtonVisibility(false);
    win.setVibrancy(null);
    win.setBackgroundColor('#00000000');
    windowStore.invalidateIfChanged();
    const remembered = windowStore.read().bounds ?? { ...bounds, width: 760, height: 480 };
    const area = screen.getDisplayMatching(remembered).workArea;
    const hudBounds = fitHudBounds(remembered, area);
    win.setBounds(hudBounds);
    tracking.start(hudBounds);
    win.setAlwaysOnTop(true, 'floating');
    layer = 1;
    pointer.activate();
  },
  exit() {
    pointer.deactivate();
    tracking.stop();
    restoreWindow?.();
    restoreWindow = null;
  },
  hide() {
    const win = hudWindow;
    if (!win || win.isDestroyed()) throw new Error('HUD_INACTIVE');
    const permission = systemPreferences.getMediaAccessStatus('screen');
    if (permission === 'denied' || permission === 'restricted')
      throw new Error('HUD_SCREEN_PERMISSION');
    captureWindow = win;
    captureDisplay = String(screen.getDisplayMatching(win.getBounds()).id);
    wasVisible = win.isVisible();
    win.hide();
  },
  reveal() {
    if (wasVisible && captureWindow && !captureWindow.isDestroyed()) captureWindow.showInactive();
    wasVisible = false;
    captureWindow = null;
  },
  async capture(assertCurrent) {
    // Let WindowServer commit hide before one-shot capture; never poll or record.
    await new Promise((resolve) => setTimeout(resolve, 180));
    // Cancel stale requests before touching OS pixels, including off/on pairs.
    assertCurrent();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1200 },
    });
    const source = sources.find((item) => item.display_id === captureDisplay);
    if (!source || source.thumbnail.isEmpty()) throw new Error('HUD_CAPTURE_FAILED');
    return new Uint8Array(source.thumbnail.toPNG());
  },
});
let registeredPointerShortcut: string | null = null;
const pointer = createHudPassThroughController({
  shouldIgnore(region) {
    const win = hudWindow;
    const current = controller.snapshot();
    if (!win || win.isDestroyed() || !current.active || current.capturing || tracking.isMoving())
      return false;
    // macOS drag regions do not emit DOM mouse events. Keep the native titlebar
    // recoverable even if the last renderer region came from the chat background.
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    if (cursor.y >= bounds.y && cursor.y < bounds.y + 34) return false;
    const settings = readSettings();
    switch (region) {
      case 'background':
        return settings.passThroughBackground;
      case 'userMessages':
        return settings.passThroughUserMessages;
      case 'assistantMessages':
        return settings.passThroughAssistantMessages;
      case 'composer':
        return settings.passThroughComposer;
      default:
        return false;
    }
  },
  ignore(value) {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    if (value) hudWindow.setIgnoreMouseEvents(true, { forward: true });
    else hudWindow.setIgnoreMouseEvents(false);
  },
  registerShortcut(callback) {
    const combo = getAppShortcutStore().getEffectiveCombos('hud-toggle-pass-through')[0];
    if (!combo || !isGlobalAppShortcutComboUsable(combo, process.platform)) return false;
    const accelerator = combo && comboToElectronAccelerator(combo, process.platform);
    if (!accelerator || globalShortcut.isRegistered(accelerator)) return false;
    if (!globalShortcut.register(accelerator, callback)) return false;
    registeredPointerShortcut = accelerator;
    return true;
  },
  unregisterShortcut() {
    if (registeredPointerShortcut) globalShortcut.unregister(registeredPointerShortcut);
    registeredPointerShortcut = null;
  },
  recoverFocus() {
    if (hudWindow && !hudWindow.isDestroyed() && !controller.snapshot().capturing) {
      hudWindow.show();
      hudWindow.focus();
    }
  },
  changed: publish,
});
function state(): HudState {
  return {
    ...controller.snapshot(),
    passThrough: pointer.isEnabled(),
    layer,
    moving: tracking.isMoving(),
    settings: readSettings(),
  };
}
export function isHudWindow(win: BrowserWindow): boolean {
  return hudWindow === win && controller.snapshot().active;
}
/** Attach only the original main window; guests/secondary windows never get capture authority. */
export function attachHudWindow(win: BrowserWindow) {
  pointer.deactivate();
  tracking.stop();
  windowGeneration++;
  hudWindow = win;
  win.on('move', () => {
    if (isHudWindow(win) && !win.isDestroyed()) tracking.observe(win.getBounds(), true);
  });
  win.on('resize', () => {
    if (isHudWindow(win) && !win.isDestroyed()) tracking.observe(win.getBounds(), false);
  });
  const invalidateEntry = () => {
    windowGeneration++;
    restoreFullscreen = false;
  };
  win.on('close', () => {
    invalidateEntry();
    if (captureWindow === win) wasVisible = false;
    controller.setActive(false);
  });
  win.webContents.on('did-start-loading', () => {
    invalidateEntry();
    controller.setActive(false);
  });
  win.webContents.on('render-process-gone', () => {
    invalidateEntry();
    controller.setActive(false);
  });
  win.on('closed', () => {
    invalidateEntry();
    controller.setActive(false);
    hudWindow = null;
  });
}
export function registerHudIpc() {
  getAppShortcutStore().subscribe(() => {
    // Release our old key before other global subscribers restore theirs. Register
    // after the notification batch so swapped bindings do not collide on reset.
    pointer.suspendShortcut(true);
    queueMicrotask(() => pointer.suspendShortcut(isAppShortcutRecordingActive()));
  });
  subscribeAppShortcutRecording((active) => pointer.suspendShortcut(active));
  pointer.suspendShortcut(isAppShortcutRecordingActive());
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    assertTrustedAppRendererEvent(event);
    if (!hudWindow || event.sender !== hudWindow.webContents)
      throwIpcError('PERMISSION_DENIED', 'HUD_PRIMARY_WINDOW_ONLY');
  };
  ipcMain.handle('hud:get', (event) => {
    guard(event);
    return state();
  });
  ipcMain.handle('hud:active', async (event, active: unknown) => {
    guard(event);
    if (typeof active !== 'boolean') throwIpcError('INVALID_ARGUMENT', 'Invalid HUD state');
    const originalWindow = hudWindow;
    const originalGeneration = windowGeneration;
    try {
      // Native fullscreen changes are asynchronous. Wait for the transition before
      // resizing; otherwise macOS ignores HUD bounds or consumes the titlebar click.
      if (active && hudWindow?.isFullScreen() && !enteringFullscreenTransition) {
        const win = hudWindow;
        enteringFullscreenTransition = new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timeout);
            win.removeListener('closed', closed);
            resolve();
          };
          const closed = () => {
            clearTimeout(timeout);
            win.removeListener('leave-full-screen', done);
            reject(new Error('HUD_INACTIVE'));
          };
          const timeout = setTimeout(() => {
            win.removeListener('leave-full-screen', done);
            win.removeListener('closed', closed);
            reject(new Error('HUD_FULLSCREEN'));
          }, 5000);
          win.once('leave-full-screen', done);
          win.once('closed', closed);
          win.setFullScreen(false);
        });
        restoreFullscreen = true;
      }
      if (enteringFullscreenTransition) {
        try {
          await enteringFullscreenTransition;
        } finally {
          enteringFullscreenTransition = null;
        }
      }
      if (
        originalGeneration !== windowGeneration ||
        hudWindow !== originalWindow ||
        !hudWindow ||
        hudWindow.isDestroyed()
      )
        throw new Error('HUD_INACTIVE');
      controller.setActive(active);
    } catch (error) {
      // A failed entry owns no fullscreen restoration. Do not clear the state
      // of a replacement window or an already active HUD.
      if (
        originalGeneration === windowGeneration &&
        hudWindow === originalWindow &&
        !controller.snapshot().active
      ) {
        restoreFullscreen = false;
      }
      throwIpcError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'HUD_FAILED');
    }
    return state();
  });
  // Only this main window's presentation changes; no remote task protocol or persistence.
  ipcMain.handle('hud:layer', (event, step: unknown) => {
    guard(event);
    if (step !== -1 && step !== 1) throwIpcError('INVALID_ARGUMENT', 'Invalid HUD layer step');
    const win = hudWindow;
    const snapshot = controller.snapshot();
    if (!snapshot.active || !win || win.isDestroyed())
      throwIpcError('INVALID_ARGUMENT', 'HUD_INACTIVE');
    if (snapshot.capturing) throwIpcError('INVALID_ARGUMENT', 'HUD_BUSY');
    const next = Math.max(0, Math.min(2, layer + step)) as HudLayer;
    if (next !== layer) {
      try {
        if (next === 0) win.setAlwaysOnTop(false);
        else win.setAlwaysOnTop(true, next === 1 ? 'floating' : 'modal-panel');
      } catch {
        throwIpcError('INVALID_ARGUMENT', 'HUD_FAILED');
      }
      layer = next;
      publish();
    }
    return state();
  });
  ipcMain.handle('hud:pass-through', (event, enabled: unknown) => {
    guard(event);
    if (typeof enabled !== 'boolean')
      throwIpcError('INVALID_ARGUMENT', 'Invalid HUD pass-through state');
    if (enabled && !controller.snapshot().active) throwIpcError('INVALID_ARGUMENT', 'HUD_INACTIVE');
    try {
      pointer.setEnabled(enabled);
    } catch (error) {
      throwIpcError(
        'INVALID_ARGUMENT',
        error instanceof Error && error.message === 'HUD_SHORTCUT_UNAVAILABLE'
          ? 'HUD_SHORTCUT_UNAVAILABLE'
          : 'HUD_FAILED',
      );
    }
    return state();
  });
  ipcMain.handle('hud:pointer-region', (event, region: unknown) => {
    guard(event);
    if (typeof region !== 'string' || !(HUD_POINTER_REGIONS as readonly string[]).includes(region))
      throwIpcError('INVALID_ARGUMENT', 'Invalid HUD pointer region');
    try {
      pointer.setRegion(region as HudPointerRegion);
    } catch {
      throwIpcError('INVALID_ARGUMENT', 'HUD_FAILED');
    }
  });
  ipcMain.handle('hud:settings', (event, raw: unknown) => {
    guard(event);
    const patch = parseHudPatch(raw);
    if (!patch) throwIpcError('INVALID_ARGUMENT', 'Invalid HUD settings');
    if (patch.allowScreen === false) controller.revokeCapture();
    store.writePatch(patch, { preserveDefaults: true });
    publish();
    return state();
  });
  ipcMain.handle('hud:reset', (event) => {
    guard(event);
    controller.revokeCapture();
    store.reset();
    publish();
    return state();
  });
  ipcMain.handle('hud:screen-permission', async (event) => {
    guard(event);
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });
  ipcMain.handle('hud:capture', async (event, raw: unknown) => {
    guard(event);
    const value = raw as { text?: unknown; explicit?: unknown } | null;
    if (
      !value ||
      typeof value.text !== 'string' ||
      value.text.length > 100000 ||
      typeof value.explicit !== 'boolean' ||
      (!value.explicit && !isHudScreenQuestion(value.text))
    ) {
      throwIpcError('INVALID_ARGUMENT', 'HUD_SCREEN_REQUEST_REQUIRED');
    }
    try {
      return await controller.capture();
    } catch (error) {
      const message =
        error instanceof Error && /^HUD_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'HUD_CAPTURE_FAILED';
      throwIpcError('PERMISSION_DENIED', message);
    }
  });
}
