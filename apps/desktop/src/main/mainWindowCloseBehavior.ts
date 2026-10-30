import type { LinuxCloseBehavior } from '../shared/windowBehavior.js';

/** BrowserWindow surface needed for Linux's keep-running close action. */
export interface LinuxCloseBehaviorWindow {
  hide(): void;
  minimize(): void;
}

/**
 * How the "keep running" close choice keeps the app alive. On Linux Wayland most
 * compositors (e.g. Hyprland) never act on toplevel minimize requests, so the
 * window must hide to tray instead; X11 keeps the classic minimize.
 */
export interface LinuxCloseBehaviorActions {
  quit(): void;
  keepRunning(window: LinuxCloseBehaviorWindow): void;
}

/**
 * True when running under a Wayland session. `XDG_SESSION_TYPE` is the primary
 * signal, but compositors started from a TTY (Hyprland, Sway) can leave it at
 * `tty`, so any value other than an explicit `x11` falls back to a set
 * `WAYLAND_DISPLAY` — the same independent positive signal as
 * remote-desktop/waylandCapture.ts `isWaylandDesktop`.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.XDG_SESSION_TYPE === 'x11') return false;
  if (env.XDG_SESSION_TYPE === 'wayland') return true;
  return Boolean(env.WAYLAND_DISPLAY);
}

/** Where the Linux keep-running choice parks the main window. */
export type LinuxKeepRunningSurface = 'tray' | 'minimize';

/**
 * Wayland compositors ignore toplevel minimize requests, so keep-running must
 * hide the main window to tray there; X11 keeps the classic minimize.
 */
export function resolveLinuxKeepRunningSurface(
  wayland: boolean,
): LinuxKeepRunningSurface {
  return wayland ? 'tray' : 'minimize';
}

/**
 * True only for the main window's minimize intent on Wayland, which must map to
 * hide-to-tray; secondary windows keep the classic minimize on every platform.
 */
export function minimizeRequestMapsToTray(isWayland: boolean, isMainWindow: boolean): boolean {
  return isWayland && isMainWindow;
}

/** Injectable side effects for hiding to tray, kept out of the Electron adapter. */
export interface TrayHideFallbackDependencies<TWindow> {
  ensureTray(): boolean;
  hideToTray(window: TWindow): void;
  reportTrayError(window: TWindow): void;
}

/**
 * Hide to tray only when the tray icon exists; otherwise surface the error and
 * keep the window open so running tasks stay reachable.
 */
export function hideToTrayWithFallback<TWindow>(
  window: TWindow,
  deps: TrayHideFallbackDependencies<TWindow>,
): void {
  if (deps.ensureTray()) {
    deps.hideToTray(window);
    return;
  }
  deps.reportTrayError(window);
}

/** Apply the persisted Linux choice without coupling the policy to Electron globals. */
export function applyLinuxMainWindowCloseBehavior(
  window: LinuxCloseBehaviorWindow,
  behavior: LinuxCloseBehavior,
  actions: LinuxCloseBehaviorActions,
): void {
  if (behavior === 'minimize') {
    actions.keepRunning(window);
  } else {
    actions.quit();
  }
}

/** BrowserWindow surface needed to reveal the renderer-owned close behavior dialog. */
export interface MainWindowClosePromptWindow {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** Keep the main window visible and ask its renderer to show the platform chooser. */
export function requestMainWindowCloseBehavior(
  window: MainWindowClosePromptWindow,
  channel: string,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.send(channel);
}

/** Injectable side effects for the renderer-first close behavior prompt flow. */
export interface CloseBehaviorPromptFallbackDependencies<TBehavior> {
  readBehavior(): TBehavior | null;
  showRendererPrompt(): void;
  showNativePrompt(): TBehavior;
  persistBehavior(behavior: TBehavior): void;
  applyBehavior(behavior: TBehavior): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Lifecycle exposed to the Electron adapter for requests, renderer ACKs, and shutdown. */
export interface CloseBehaviorPromptFallbackController {
  request(): void;
  acknowledge(): void;
  dispose(): void;
}

/**
 * Prefer the Cindy renderer dialog, but fall back to a native prompt if the renderer never
 * confirms that the dialog mounted. This keeps first-close reliable during startup or crashes.
 */
export function createCloseBehaviorPromptFallbackController<TBehavior>(
  deps: CloseBehaviorPromptFallbackDependencies<TBehavior>,
  fallbackDelayMs: number,
): CloseBehaviorPromptFallbackController {
  let fallbackHandle: unknown;

  const cancelFallback = (): void => {
    if (fallbackHandle === undefined) return;
    deps.cancel(fallbackHandle);
    fallbackHandle = undefined;
  };

  const runFallback = (): void => {
    fallbackHandle = undefined;
    if (deps.readBehavior()) return;

    const behavior = deps.showNativePrompt();
    // The renderer can persist a choice while the native dialog is open; keep the first choice.
    if (deps.readBehavior()) return;
    deps.persistBehavior(behavior);
    deps.applyBehavior(behavior);
  };

  return {
    request() {
      if (deps.readBehavior()) return;
      deps.showRendererPrompt();
      if (fallbackHandle !== undefined) return;
      fallbackHandle = deps.schedule(runFallback, fallbackDelayMs);
    },
    acknowledge() {
      cancelFallback();
    },
    dispose() {
      cancelFallback();
    },
  };
}
