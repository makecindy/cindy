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
  | 'maximize'
  | 'unmaximize'
  | 'closed'
  | 'show'
  | 'restore'
  | 'leave-full-screen'
  | 'will-move'
  | 'will-resize';

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
  modifiers?: string[];
}

interface MaximizeRecoveryMouseInput {
  type: string;
  button?: string;
  clickCount?: number;
  y: number;
}

type MaximizeRecoveryUserIntentSource = 'before-unmaximize' | 'after-unmaximize';

const WM_SYSCOMMAND = 0x0112;
const SC_RESTORE = 0xf120;
const SYSTEM_COMMAND_MASK = 0xfff0;

export interface MaximizeRecoveryNativeWindow extends MaximizeRecoveryWindow {
  hookWindowMessage(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void;
  unhookWindowMessage(message: number): void;
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
  notifyUserUnmaximizeIntent: (source?: MaximizeRecoveryUserIntentSource) => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {};

  const onWillMove = (): void =>
    notifyUserUnmaximizeIntent(win.isMaximized() ? 'before-unmaximize' : 'after-unmaximize');
  const onWillResize = (): void =>
    notifyUserUnmaximizeIntent(win.isMaximized() ? 'before-unmaximize' : 'after-unmaximize');
  const onSystemCommand = (wParam: Buffer): void => {
    if (wParam.byteLength >= 4 && (wParam.readUInt32LE(0) & SYSTEM_COMMAND_MASK) === SC_RESTORE) {
      notifyUserUnmaximizeIntent('before-unmaximize');
    }
  };
  const onBeforeMouseEvent = (_event: unknown, mouse: MaximizeRecoveryMouseInput): void => {
    if (
      mouse.type === 'mouseDown' &&
      mouse.button === 'left' &&
      mouse.clickCount === 2 &&
      mouse.y >= 0 &&
      mouse.y <= 46
    ) {
      notifyUserUnmaximizeIntent('before-unmaximize');
    }
  };
  const onBeforeInputEvent = (_event: unknown, input: MaximizeRecoveryInput): void => {
    const hasWindowsModifier =
      input.meta ||
      input.modifiers?.includes('meta') === true ||
      input.modifiers?.includes('command') === true;
    if (
      input.type === 'keyDown' &&
      !input.isAutoRepeat &&
      input.key === 'ArrowDown' &&
      hasWindowsModifier
    ) {
      notifyUserUnmaximizeIntent('before-unmaximize');
    }
  };

  win.on('will-move', onWillMove);
  win.on('will-resize', onWillResize);
  win.hookWindowMessage(WM_SYSCOMMAND, onSystemCommand);
  win.webContents.on('before-mouse-event', onBeforeMouseEvent);
  win.webContents.on('before-input-event', onBeforeInputEvent);

  return (): void => {
    win.removeListener('will-move', onWillMove);
    win.removeListener('will-resize', onWillResize);
    win.unhookWindowMessage(WM_SYSCOMMAND);
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
  /** How long a native input signal may be paired with an actual unmaximize. */
  userIntentMs?: number;
}

export interface MainWindowMaximizeRecoveryController {
  /** Stop listening for display and window state changes. */
  dispose(): void;
  /** Record a possible user restore; it only disarms once unmaximize is observed. */
  notifyUserUnmaximizeIntent(source?: MaximizeRecoveryUserIntentSource): void;
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
  const userIntentMs = options.userIntentMs ?? 500;

  let armed = options.armed;
  let disposed = false;
  let pendingRecovery = false;
  let pendingUserUnmaximizeAtMs: number | null = null;
  let lastUnmaximizeAtMs: number | null = null;
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

  const disarmForConfirmedUserUnmaximize = (): void => {
    armed = false;
    pendingRecovery = false;
    pendingUserUnmaximizeAtMs = null;
    lastUnmaximizeAtMs = null;
    lastDisplayChangeAtMs = null;
    clearReapply();
    clearDisarm();
  };

  const notifyUserUnmaximizeIntent = (
    source: MaximizeRecoveryUserIntentSource = 'before-unmaximize',
  ): void => {
    if (disposed) return;
    const at = now();
    if (source === 'after-unmaximize') {
      // Manual move/resize can be reported immediately after `unmaximize`.
      // Only these concrete native transitions may confirm a late signal;
      // title-bar clicks and key events must never pair with an older OS event.
      if (
        lastUnmaximizeAtMs !== null &&
        at - lastUnmaximizeAtMs >= 0 &&
        at - lastUnmaximizeAtMs <= userIntentMs &&
        !win.isMaximized()
      ) {
        disarmForConfirmedUserUnmaximize();
      }
      return;
    }
    if (!win.isMaximized()) return;
    if (
      lastUnmaximizeAtMs !== null &&
      at - lastUnmaximizeAtMs >= 0 &&
      at - lastUnmaximizeAtMs <= userIntentMs
    ) {
      // A click or key event that arrives after an OS transition is not proof
      // that it caused that transition, so do not retain it as pending intent.
      return;
    }
    pendingUserUnmaximizeAtMs = at;
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
    win.removeListener('leave-full-screen', onWindowAvailable);
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
    const at = now();
    // An unmaximize immediately before this change belongs to the OS re-layout.
    clearDisarm();
    // A native restore signal from before the current display generation must
    // not confirm the OS unmaximize caused by this new display re-layout. Keep
    // signals created after the last display event so a burst of display/DPI
    // notifications cannot discard the same user gesture before unmaximize.
    if (
      pendingUserUnmaximizeAtMs !== null &&
      (lastDisplayChangeAtMs === null ||
        pendingUserUnmaximizeAtMs < lastDisplayChangeAtMs ||
        at - lastDisplayChangeAtMs > graceMs)
    ) {
      pendingUserUnmaximizeAtMs = null;
    }
    lastDisplayChangeAtMs = at;
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
    pendingUserUnmaximizeAtMs = null;
    lastUnmaximizeAtMs = null;
  };

  const onUnmaximize = (): void => {
    if (disposed || !armed) return;
    const at = now();
    lastUnmaximizeAtMs = at;
    if (
      pendingUserUnmaximizeAtMs !== null &&
      at - pendingUserUnmaximizeAtMs >= 0 &&
      at - pendingUserUnmaximizeAtMs <= userIntentMs
    ) {
      disarmForConfirmedUserUnmaximize();
      return;
    }
    pendingUserUnmaximizeAtMs = null;
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
  win.on('leave-full-screen', onWindowAvailable);
  win.on('closed', dispose);
  return { dispose, notifyUserUnmaximizeIntent };
}
