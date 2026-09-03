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

type WindowStateEvent = 'maximize' | 'unmaximize' | 'closed';

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

/**
 * Keeps the main window maximized across display topology / DPI changes while
 * the user's last choice was "maximized"; the user's own maximize / unmaximize
 * re-arms / disarms it. Returns a disposer; also tears down on window close.
 */
export function installMainWindowMaximizeRecovery(
  win: MaximizeRecoveryWindow,
  screen: MaximizeRecoveryScreen,
  options: MaximizeRecoveryOptions,
): () => void {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const settleMs = options.settleMs ?? 300;
  const graceMs = options.graceMs ?? 2_000;

  let armed = options.armed;
  let disposed = false;
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearReapply();
    clearDisarm();
    for (const event of DISPLAY_CHANGE_EVENTS) screen.removeListener(event, onDisplayChange);
    win.removeListener('maximize', onMaximize);
    win.removeListener('unmaximize', onUnmaximize);
    win.removeListener('closed', dispose);
  };

  const reapply = (): void => {
    reapplyTimer = null;
    if (disposed || !armed || win.isDestroyed()) return;
    // A hidden window (closed to tray) must not be surfaced, and a minimized
    // or fullscreen one reflects a deliberate state we should not override.
    if (!win.isVisible() || win.isMinimized() || win.isFullScreen() || win.isMaximized()) return;
    options.log?.info('re-applying maximized state after display change');
    win.maximize();
  };

  const onDisplayChange = (): void => {
    if (disposed) return;
    lastDisplayChangeAtMs = now();
    // An unmaximize immediately before this change belongs to the OS re-layout.
    clearDisarm();
    if (!armed) return;
    clearReapply();
    reapplyTimer = setTimer(reapply, settleMs);
  };

  const onMaximize = (): void => {
    if (disposed) return;
    clearDisarm();
    armed = true;
  };

  const onUnmaximize = (): void => {
    if (disposed || !armed) return;
    const at = now();
    if (lastDisplayChangeAtMs !== null && at - lastDisplayChangeAtMs <= graceMs) return;
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
  win.on('closed', dispose);
  return dispose;
}
