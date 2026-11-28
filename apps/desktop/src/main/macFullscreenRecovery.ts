import { app, powerMonitor, screen, type BrowserWindow, type Rectangle } from 'electron';
import { createLogger } from './logger.js';
import {
  inspectMacWindowFullscreen,
  type MacWindowFullscreenInspection,
} from './macosDesktopBlur.js';

const defaultLog = createLogger('mac-fullscreen-recovery');

/** CoreGraphics Space types (CGSSpaceGetType). */
export const CGS_SPACE_TYPE_USER = 0;
export const CGS_SPACE_TYPE_FULLSCREEN = 4;

/** Fallback bounds divergence threshold when CGS Space SPIs are unavailable. */
const CG_BOUNDS_MISMATCH_TOLERANCE_PX = 16;

const DEFAULT_ENTER_SETTLE_MS = 2_000;
const DEFAULT_CONFIRM_DELAY_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 1_500;
const DEFAULT_RECOVERY_COOLDOWN_MS = 10_000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;

export type FullscreenDesyncReason =
  | 'space-not-fullscreen'
  | 'cg-bounds-mismatch'
  | null;

export type MacFullscreenWindowEvent =
  | 'enter-full-screen'
  | 'leave-full-screen'
  | 'focus'
  | 'show'
  | 'hide'
  | 'minimize'
  | 'restore'
  | 'move'
  | 'resize'
  | 'closed';

export interface MacFullscreenRecoveryWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isSimpleFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  setWindowButtonVisibility?(visible: boolean): void;
  setWindowButtonPosition?(position: { x: number; y: number } | null): void;
  webContents: {
    isDestroyed?: () => boolean;
    send(channel: string, ...args: unknown[]): void;
  };
  on(event: MacFullscreenWindowEvent, listener: () => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: MacFullscreenWindowEvent, listener: () => void): unknown;
}

export interface MacFullscreenRecoveryScreen {
  getDisplayMatching(rect: Rectangle): { workArea: Rectangle };
  on(
    event: 'display-added' | 'display-removed' | 'display-metrics-changed',
    listener: () => void,
  ): unknown;
  removeListener(
    event: 'display-added' | 'display-removed' | 'display-metrics-changed',
    listener: () => void,
  ): unknown;
}

export interface MacFullscreenRecoveryPowerMonitor {
  on(event: 'resume' | 'unlock-screen', listener: () => void): unknown;
  removeListener(event: 'resume' | 'unlock-screen', listener: () => void): unknown;
}

export interface MacFullscreenRecoveryApp {
  on(event: 'activate', listener: () => void): unknown;
  removeListener(event: 'activate', listener: () => void): unknown;
}

export interface MacFullscreenRecoveryOptions {
  windowLabel?: string;
  trafficLightPosition?: { x: number; y: number };
  minSize?: { width: number; height: number };
  shouldShowWindowButtons?: () => boolean;
  platform?: NodeJS.Platform;
  screen?: MacFullscreenRecoveryScreen;
  powerMonitor?: MacFullscreenRecoveryPowerMonitor;
  app?: MacFullscreenRecoveryApp;
  inspect?: (win: MacFullscreenRecoveryWindow) => MacWindowFullscreenInspection | null;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  enterSettleMs?: number;
  confirmDelayMs?: number;
  pollIntervalMs?: number;
  recoveryTimeoutMs?: number;
  recoveryCooldownMs?: number;
  maxRecoveryAttempts?: number;
}

/**
 * Classifies whether a settled native-fullscreen macOS window has desynced from
 * WindowServer (dropped onto a regular Desktop Space while AppKit still keeps
 * NSWindowStyleMaskFullScreen and hides native traffic lights).
 */
export function classifyMacFullscreenDesync(
  inspection: MacWindowFullscreenInspection | null,
  appBounds: Rectangle,
): FullscreenDesyncReason {
  if (!inspection) return null;
  if (!inspection.styleMaskFullScreen || !inspection.visible) return null;

  // Primary signal (authoritative when CGS Space SPIs are available):
  // A settled native fullscreen window (including Split View tiles) belongs to
  // a fullscreen space (type 4). An empty list means ordered-out/transitioning
  // and must never be treated as desync.
  if (inspection.spaceTypes !== null) {
    if (inspection.spaceTypes.length === 0) return null;
    if (inspection.spaceTypes.includes(CGS_SPACE_TYPE_FULLSCREEN)) return null;
    if (inspection.spaceTypes.includes(CGS_SPACE_TYPE_USER)) {
      return 'space-not-fullscreen';
    }
    return null;
  }

  // Fallback signal (public CGWindowListCopyWindowInfo only, if CGS Space SPIs
  // become unavailable on a future macOS): on-screen window whose WindowServer
  // bounds diverge substantially from AppKit's frame while AppKit still thinks
  // it is fullscreen.
  if (inspection.cgOnScreen === true && inspection.cgBounds) {
    const cg = inspection.cgBounds;
    if (
      Math.abs(cg.x - appBounds.x) > CG_BOUNDS_MISMATCH_TOLERANCE_PX ||
      Math.abs(cg.y - appBounds.y) > CG_BOUNDS_MISMATCH_TOLERANCE_PX ||
      Math.abs(cg.width - appBounds.width) > CG_BOUNDS_MISMATCH_TOLERANCE_PX ||
      Math.abs(cg.height - appBounds.height) > CG_BOUNDS_MISMATCH_TOLERANCE_PX
    ) {
      return 'cg-bounds-mismatch';
    }
  }

  return null;
}

/**
 * Fits a recovered windowed rectangle cleanly inside the display work area when
 * it extends past any edge (e.g. a fullscreen-sized window shifted off-screen).
 * Returns null if the rectangle is already completely inside the work area.
 */
export function fitBoundsInsideWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
  minSize?: { width: number; height: number },
): Rectangle | null {
  if (workArea.width <= 0 || workArea.height <= 0) return null;

  const alreadyInside =
    bounds.x >= workArea.x &&
    bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height;
  if (alreadyInside) return null;

  const minWidth = Math.min(minSize?.width ?? 0, workArea.width);
  const minHeight = Math.min(minSize?.height ?? 0, workArea.height);
  const width = Math.max(minWidth, Math.min(bounds.width, workArea.width));
  const height = Math.max(minHeight, Math.min(bounds.height, workArea.height));
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  const x = Math.min(Math.max(bounds.x, workArea.x), maxX);
  const y = Math.min(Math.max(bounds.y, workArea.y), maxY);

  if (
    x === bounds.x &&
    y === bounds.y &&
    width === bounds.width &&
    height === bounds.height
  ) {
    return null;
  }

  return { x, y, width, height };
}

/**
 * Installs automatic detection and self-healing for macOS native fullscreen
 * Space desyncs, where WindowServer drops a fullscreen window back onto a
 * regular Desktop Space while AppKit keeps NSWindowStyleMaskFullScreen set
 * (leaving native traffic lights hidden and the window clipped off-screen).
 *
 * Uses a two-step confirmation delay longer than macOS's native fullscreen
 * transition animation and strictly ignores simpleFullScreen, hidden/minimized
 * windows, and mid-transition windows to avoid false positives.
 */
function readOptionalElectronExport<T>(reader: () => T | undefined): T | null {
  try {
    return reader() ?? null;
  } catch {
    return null;
  }
}

export function installMacFullscreenDesyncRecovery(
  win: MacFullscreenRecoveryWindow,
  options: MacFullscreenRecoveryOptions = {},
): () => void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return () => {};

  const screenApi = options.screen ?? readOptionalElectronExport(() => screen);
  const powerMonitorApi = options.powerMonitor ?? readOptionalElectronExport(() => powerMonitor);
  const appApi = options.app ?? readOptionalElectronExport(() => app);
  const inspect =
    options.inspect ??
    ((target) => inspectMacWindowFullscreen(target as unknown as BrowserWindow));
  const log = options.log ?? defaultLog;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setIntervalFn = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const shouldShowWindowButtons = options.shouldShowWindowButtons ?? (() => true);

  const windowLabel = options.windowLabel ?? 'window';
  const enterSettleMs = options.enterSettleMs ?? DEFAULT_ENTER_SETTLE_MS;
  const confirmDelayMs = options.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  const recoveryCooldownMs = options.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;

  let disposed = false;
  let inNativeFullscreen = false;
  let settled = false;
  let recovering = false;
  let pendingRecoveryFinalization = false;
  let recoveryAttempts = 0;
  let lastRecoveryAt: number | null = null;

  let settleTimer: unknown = null;
  let confirmTimer: unknown = null;
  let recoveryTimer: unknown = null;
  let pollTimer: unknown = null;

  const clearHandle = (handle: unknown, clear: (h: unknown) => void): null => {
    if (handle !== null) clear(handle);
    return null;
  };

  const stopPolling = (): void => {
    pollTimer = clearHandle(pollTimer, clearIntervalFn);
  };

  const cancelConfirmation = (): void => {
    confirmTimer = clearHandle(confirmTimer, clearTimer);
  };

  const startPolling = (): void => {
    if (
      disposed ||
      pollTimer !== null ||
      !inNativeFullscreen ||
      !settled ||
      recovering ||
      recoveryAttempts >= maxRecoveryAttempts
    ) {
      return;
    }
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    pollTimer = setIntervalFn(() => {
      probe('poll');
    }, pollIntervalMs);
  };

  const canProbe = (): boolean => {
    if (disposed || !inNativeFullscreen || !settled || recovering) return false;
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
    if (!win.isFullScreen() || win.isSimpleFullScreen()) return false;
    if (recoveryAttempts >= maxRecoveryAttempts) return false;
    if (lastRecoveryAt !== null && now() - lastRecoveryAt < recoveryCooldownMs) return false;
    return true;
  };

  const finalizeWindowedRecovery = (forceSyncRenderer: boolean): void => {
    if (disposed || win.isDestroyed()) return;
    if (win.isFullScreen() || win.isSimpleFullScreen()) return;

    if (shouldShowWindowButtons()) {
      win.setWindowButtonVisibility?.(true);
      if (options.trafficLightPosition) {
        win.setWindowButtonPosition?.(options.trafficLightPosition);
      }
    }

    let adjustedBounds: Rectangle | null = null;
    if (screenApi && typeof screenApi.getDisplayMatching === 'function') {
      try {
        const bounds = win.getBounds();
        const workArea = screenApi.getDisplayMatching(bounds).workArea;
        const fitted = fitBoundsInsideWorkArea(bounds, workArea, options.minSize);
        if (fitted) {
          win.setBounds(fitted);
          adjustedBounds = fitted;
        }
      } catch (error: unknown) {
        log.warn('Failed to clamp recovered macOS window bounds', {
          windowLabel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (forceSyncRenderer && !win.webContents.isDestroyed?.()) {
      win.webContents.send('fullscreen-change', false);
    }

    log.info('Recovered macOS window from fullscreen Space desync', {
      windowLabel,
      adjustedBounds,
      forceSyncRenderer,
    });
  };

  const beginRecovery = (
    trigger: string,
    reason: Exclude<FullscreenDesyncReason, null>,
    inspection: MacWindowFullscreenInspection,
    appBounds: Rectangle,
  ): void => {
    recovering = true;
    pendingRecoveryFinalization = true;
    recoveryAttempts += 1;
    lastRecoveryAt = now();
    stopPolling();
    cancelConfirmation();

    log.warn('Detected macOS fullscreen Space desync; exiting fullscreen to recover controls', {
      windowLabel,
      trigger,
      reason,
      attempt: recoveryAttempts,
      maxAttempts: maxRecoveryAttempts,
      spaceTypes: inspection.spaceTypes,
      onActiveSpace: inspection.onActiveSpace,
      appBounds,
      cgBounds: inspection.cgBounds,
    });

    try {
      win.setFullScreen(false);
    } catch (error: unknown) {
      recovering = false;
      pendingRecoveryFinalization = false;
      log.warn('Failed to call setFullScreen(false) during macOS fullscreen recovery', {
        windowLabel,
        attempt: recoveryAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // `leave-full-screen` may have fired synchronously during setFullScreen(false).
    if (!recovering || disposed || win.isDestroyed()) return;

    recoveryTimer = setTimer(() => {
      recoveryTimer = null;
      recovering = false;
      if (disposed || win.isDestroyed()) return;

      if (!win.isFullScreen()) {
        inNativeFullscreen = false;
        settled = false;
        pendingRecoveryFinalization = false;
        recoveryAttempts = 0;
        stopPolling();
        finalizeWindowedRecovery(true);
        return;
      }

      // Keep pendingRecoveryFinalization armed: a slow native exit that emits
      // leave-full-screen after the timeout still needs button/bounds recovery.
      log.warn('macOS fullscreen desync recovery attempt did not exit fullscreen', {
        windowLabel,
        attempt: recoveryAttempts,
        maxAttempts: maxRecoveryAttempts,
      });
      if (recoveryAttempts < maxRecoveryAttempts) {
        startPolling();
      }
    }, recoveryTimeoutMs);
  };

  const confirmAndRecover = (trigger: string): void => {
    if (!canProbe()) return;
    const appBounds = win.getBounds();
    const inspection = inspect(win);
    const reason = classifyMacFullscreenDesync(inspection, appBounds);
    if (!reason || !inspection) return;
    beginRecovery(trigger, reason, inspection, appBounds);
  };

  const probe = (trigger: string): void => {
    if (!canProbe()) {
      if (
        !inNativeFullscreen ||
        win.isDestroyed() ||
        !win.isVisible() ||
        win.isMinimized() ||
        !win.isFullScreen() ||
        win.isSimpleFullScreen()
      ) {
        cancelConfirmation();
      }
      return;
    }

    const appBounds = win.getBounds();
    const inspection = inspect(win);
    const reason = classifyMacFullscreenDesync(inspection, appBounds);
    if (!reason) {
      cancelConfirmation();
      return;
    }

    // Do not reset an already-armed confirmation timer when rapid events arrive.
    if (confirmTimer !== null) return;
    confirmTimer = setTimer(() => {
      confirmTimer = null;
      confirmAndRecover(trigger);
    }, confirmDelayMs);
  };

  const armFullscreenTracking = (): void => {
    if (disposed || win.isDestroyed() || win.isSimpleFullScreen()) return;
    settleTimer = clearHandle(settleTimer, clearTimer);
    cancelConfirmation();
    recoveryTimer = clearHandle(recoveryTimer, clearTimer);
    stopPolling();

    inNativeFullscreen = true;
    settled = false;
    recovering = false;
    pendingRecoveryFinalization = false;
    recoveryAttempts = 0;

    settleTimer = setTimer(() => {
      settleTimer = null;
      if (disposed || !inNativeFullscreen || win.isDestroyed()) return;
      settled = true;
      startPolling();
      probe('enter-settled');
    }, enterSettleMs);
  };

  const onEnterFullScreen = (): void => {
    armFullscreenTracking();
  };

  const onLeaveFullScreen = (): void => {
    settleTimer = clearHandle(settleTimer, clearTimer);
    cancelConfirmation();
    recoveryTimer = clearHandle(recoveryTimer, clearTimer);
    stopPolling();

    const shouldFinalize = recovering || pendingRecoveryFinalization;
    inNativeFullscreen = false;
    settled = false;
    recovering = false;
    pendingRecoveryFinalization = false;
    recoveryAttempts = 0;

    if (shouldFinalize) {
      finalizeWindowedRecovery(false);
    }
  };

  const onHideOrMinimize = (): void => {
    cancelConfirmation();
    stopPolling();
  };

  const onShowOrRestore = (): void => {
    if (!inNativeFullscreen || !settled || recovering) return;
    startPolling();
    probe('show');
  };

  const onFocus = (): void => {
    startPolling();
    probe('focus');
  };
  const onMove = (): void => probe('move');
  const onResize = (): void => probe('resize');
  const onDisplayChanged = (): void => probe('display-change');
  const onResume = (): void => probe('power-resume');
  const onUnlockScreen = (): void => probe('unlock-screen');
  const onAppActivate = (): void => probe('app-activate');

  win.on('enter-full-screen', onEnterFullScreen);
  win.on('leave-full-screen', onLeaveFullScreen);
  win.on('hide', onHideOrMinimize);
  win.on('minimize', onHideOrMinimize);
  win.on('show', onShowOrRestore);
  win.on('restore', onShowOrRestore);
  win.on('focus', onFocus);
  win.on('move', onMove);
  win.on('resize', onResize);

  if (screenApi && typeof screenApi.on === 'function') {
    screenApi.on('display-added', onDisplayChanged);
    screenApi.on('display-removed', onDisplayChanged);
    screenApi.on('display-metrics-changed', onDisplayChanged);
  }
  if (powerMonitorApi && typeof powerMonitorApi.on === 'function') {
    powerMonitorApi.on('resume', onResume);
    powerMonitorApi.on('unlock-screen', onUnlockScreen);
  }
  if (appApi && typeof appApi.on === 'function') {
    appApi.on('activate', onAppActivate);
  }

  if (
    !win.isDestroyed() &&
    typeof win.isFullScreen === 'function' &&
    win.isFullScreen() &&
    typeof win.isSimpleFullScreen === 'function' &&
    !win.isSimpleFullScreen()
  ) {
    armFullscreenTracking();
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    pendingRecoveryFinalization = false;
    settleTimer = clearHandle(settleTimer, clearTimer);
    cancelConfirmation();
    recoveryTimer = clearHandle(recoveryTimer, clearTimer);
    stopPolling();

    if (screenApi && typeof screenApi.removeListener === 'function') {
      screenApi.removeListener('display-added', onDisplayChanged);
      screenApi.removeListener('display-removed', onDisplayChanged);
      screenApi.removeListener('display-metrics-changed', onDisplayChanged);
    }
    if (powerMonitorApi && typeof powerMonitorApi.removeListener === 'function') {
      powerMonitorApi.removeListener('resume', onResume);
      powerMonitorApi.removeListener('unlock-screen', onUnlockScreen);
    }
    if (appApi && typeof appApi.removeListener === 'function') {
      appApi.removeListener('activate', onAppActivate);
    }

    if (!win.isDestroyed()) {
      win.removeListener('enter-full-screen', onEnterFullScreen);
      win.removeListener('leave-full-screen', onLeaveFullScreen);
      win.removeListener('hide', onHideOrMinimize);
      win.removeListener('minimize', onHideOrMinimize);
      win.removeListener('show', onShowOrRestore);
      win.removeListener('restore', onShowOrRestore);
      win.removeListener('focus', onFocus);
      win.removeListener('move', onMove);
      win.removeListener('resize', onResize);
    }
  };

  win.once('closed', dispose);
  return dispose;
}
