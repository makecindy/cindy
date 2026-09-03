import fs from 'node:fs';

/**
 * electron-window-state drops `isMaximized` together with the saved bounds
 * whenever the saved rectangle is not inside any currently attached display.
 * That happens on Windows when the app is relaunched (e.g. idle auto-update)
 * while the laptop lid is closed or the monitor is asleep: the only display
 * Windows reports is a placeholder that neither contains the saved bounds nor
 * has the real scale factor, so the window comes back small and rendered at 1x.
 *
 * Read the persisted flag from the raw file so the caller can maximize
 * regardless of that bounds validation.
 */
export function readPersistedWindowMaximized(
  filePath: string,
  readFileSync: (path: string, encoding: 'utf8') => string = fs.readFileSync,
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { isMaximized?: unknown }).isMaximized === true
    );
  } catch {
    return false;
  }
}

export type DisplayChangeEvent = 'display-added' | 'display-removed' | 'display-metrics-changed';

const DISPLAY_CHANGE_EVENTS: readonly DisplayChangeEvent[] = [
  'display-added',
  'display-removed',
  'display-metrics-changed',
];

type WindowStateEvent =
  'maximize' | 'unmaximize' | 'closed' | 'show' | 'restore' | 'will-move' | 'will-resize';

export interface MaximizeRecoveryWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  maximize(): void;
  on(event: WindowStateEvent, listener: () => void): unknown;
  removeListener(event: WindowStateEvent, listener: () => void): unknown;
}

export interface MaximizeRecoveryScreen {
  on(event: DisplayChangeEvent, listener: () => void): unknown;
  removeListener(event: DisplayChangeEvent, listener: () => void): unknown;
}

interface MaximizeRecoveryInput {
  type: string;
  key: string;
  meta: boolean;
  isAutoRepeat: boolean;
  modifiers: string[];
}

interface MaximizeRecoveryMouseInput {
  type: string;
  button?: string;
  clickCount?: number;
  y: number;
}

export interface MaximizeRecoveryNativeWindow extends MaximizeRecoveryWindow {
  webContents: {
    on(
      event: 'before-input-event',
      listener: (event: unknown, input: MaximizeRecoveryInput) => void,
    ): unknown;
    removeListener(
      event: 'before-input-event',
      listener: (event: unknown, input: MaximizeRecoveryInput) => void,
    ): unknown;
    on(
      event: 'before-mouse-event',
      listener: (event: unknown, mouse: MaximizeRecoveryMouseInput) => void,
    ): unknown;
    removeListener(
      event: 'before-mouse-event',
      listener: (event: unknown, mouse: MaximizeRecoveryMouseInput) => void,
    ): unknown;
  };
}

/**
 * Marks restore gestures that do not go through Cindy's custom window-control IPC.
 * Electron exposes manual movement/resizing separately from programmatic bounds
 * changes, while the frameless title bar's double-click and Win+Down arrive via
 * webContents input events. These signals precede the native `unmaximize`
 * transition on Windows, so the recovery controller can preserve the user's choice.
 */
export function installMainWindowNativeRestoreIntent(
  win: MaximizeRecoveryNativeWindow,
  notifyUserUnmaximize: () => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {};

  const onWillMove = (): void => notifyUserUnmaximize();
  const onWillResize = (): void => notifyUserUnmaximize();
  const onBeforeMouseEvent = (_event: unknown, mouse: MaximizeRecoveryMouseInput): void => {
    if (
      mouse.type === 'mouseDown' &&
      mouse.button === 'left' &&
      mouse.clickCount === 2 &&
      mouse.y >= 0 &&
      mouse.y <= 46
    ) {
      notifyUserUnmaximize();
    }
  };
  const onBeforeInputEvent = (_event: unknown, input: MaximizeRecoveryInput): void => {
    const hasWindowsModifier =
      input.meta || input.modifiers.includes('meta') || input.modifiers.includes('command');
    if (
      input.type === 'keyDown' &&
      !input.isAutoRepeat &&
      input.key === 'ArrowDown' &&
      hasWindowsModifier
    ) {
      notifyUserUnmaximize();
    }
  };

  win.on('will-move', onWillMove);
  win.on('will-resize', onWillResize);
  win.webContents.on('before-mouse-event', onBeforeMouseEvent);
  win.webContents.on('before-input-event', onBeforeInputEvent);

  return (): void => {
    win.removeListener('will-move', onWillMove);
    win.removeListener('will-resize', onWillResize);
    win.webContents.removeListener('before-mouse-event', onBeforeMouseEvent);
    win.webContents.removeListener('before-input-event', onBeforeInputEvent);
  };
}

export interface MaximizeRecoveryOptions {
  /** Whether the window should currently be kept maximized (persisted state). */
  armed: boolean;
  log?: { info: (...args: unknown[]) => void };
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Delay before re-applying maximize, so the OS finishes its own re-layout first. */
  settleMs?: number;
  /**
   * An `unmaximize` this close to a display change is attributed to the OS and
   * keeps recovery armed; anything further away is treated as the user's choice.
   */
  graceMs?: number;
}

export interface MainWindowMaximizeRecoveryController {
  /** Stop listening for display and window state changes. */
  dispose(): void;
  /** Mark the next unmaximize as an explicit user request, not OS re-layout. */
  notifyUserUnmaximize(): void;
}

/**
 * Keeps the main window maximized across display topology / DPI changes while
 * the user's last choice was "maximized"; the user's own maximize / unmaximize
 * re-arms / disarms it. Returns a disposer; also tears down on window close.
 */
export function installMainWindowMaximizeRecovery(
  win: MaximizeRecoveryWindow,
  screen: MaximizeRecoveryScreen,
  options: MaximizeRecoveryOptions,
): MainWindowMaximizeRecoveryController {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const settleMs = options.settleMs ?? 300;
  const graceMs = options.graceMs ?? 2_000;

  let armed = options.armed;
  let disposed = false;
  let pendingRecovery = false;
  let lastDisplayChangeAtMs: number | null = null;
  let reapplyTimer: unknown = null;
  let disarmTimer: unknown = null;

  const clearReapply = (): void => {
    if (reapplyTimer !== null) clearTimer(reapplyTimer);
    reapplyTimer = null;
  };
  const clearDisarm = (): void => {
    if (disarmTimer !== null) clearTimer(disarmTimer);
    disarmTimer = null;
  };

  const notifyUserUnmaximize = (): void => {
    if (disposed) return;
    // The renderer's custom title-bar control is an explicit user choice. Clear
    // any recovery work before Electron emits `unmaximize`, so a click during
    // the display-change grace window cannot be mistaken for OS re-layout.
    armed = false;
    pendingRecovery = false;
    lastDisplayChangeAtMs = null;
    clearReapply();
    clearDisarm();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearReapply();
    clearDisarm();
    for (const event of DISPLAY_CHANGE_EVENTS) screen.removeListener(event, onDisplayChange);
    win.removeListener('maximize', onMaximize);
    win.removeListener('unmaximize', onUnmaximize);
    win.removeListener('show', onWindowAvailable);
    win.removeListener('restore', onWindowAvailable);
    win.removeListener('closed', dispose);
  };

  const reapply = (): void => {
    reapplyTimer = null;
    if (disposed || !armed || win.isDestroyed()) return;
    // A hidden window (closed to tray) must not be surfaced, and a minimized
    // or fullscreen one reflects a deliberate state we should not override.
    if (!win.isVisible() || win.isMinimized() || win.isFullScreen()) return;
    if (win.isMaximized()) {
      pendingRecovery = false;
      return;
    }
    pendingRecovery = false;
    options.log?.info('re-applying maximized state after display change');
    win.maximize();
  };

  const scheduleReapply = (): void => {
    if (disposed || !armed) return;
    clearReapply();
    reapplyTimer = setTimer(reapply, settleMs);
  };

  const onDisplayChange = (): void => {
    if (disposed) return;
    lastDisplayChangeAtMs = now();
    // An unmaximize immediately before this change belongs to the OS re-layout.
    clearDisarm();
    if (!armed) return;
    pendingRecovery = true;
    scheduleReapply();
  };

  const onWindowAvailable = (): void => {
    if (disposed || !armed || !pendingRecovery) return;
    scheduleReapply();
  };

  const onMaximize = (): void => {
    if (disposed) return;
    clearDisarm();
    armed = true;
    pendingRecovery = false;
  };

  const onUnmaximize = (): void => {
    if (disposed || !armed) return;
    const at = now();
    if (lastDisplayChangeAtMs !== null && at - lastDisplayChangeAtMs <= graceMs) {
      // Windows can emit the OS unmaximize after the first settle timer has
      // already observed a still-maximized window. Keep the recovery request
      // alive and retry after this late transition.
      pendingRecovery = true;
      scheduleReapply();
      return;
    }
    // Decide after the grace period: a display change arriving right after
    // means the OS restored the window, not the user.
    clearDisarm();
    disarmTimer = setTimer(() => {
      disarmTimer = null;
      if (disposed) return;
      if (lastDisplayChangeAtMs !== null && lastDisplayChangeAtMs >= at) return;
      armed = false;
    }, graceMs);
  };

  for (const event of DISPLAY_CHANGE_EVENTS) screen.on(event, onDisplayChange);
  win.on('maximize', onMaximize);
  win.on('unmaximize', onUnmaximize);
  win.on('show', onWindowAvailable);
  win.on('restore', onWindowAvailable);
  win.on('closed', dispose);
  return { dispose, notifyUserUnmaximize };
}
