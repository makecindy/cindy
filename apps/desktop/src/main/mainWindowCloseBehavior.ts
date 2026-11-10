import type { LinuxCloseBehavior, WindowsCloseBehavior } from '../shared/windowBehavior.js';
import type { WindowsTrayWindow } from './windowsTrayLifecycle.js';

/**
 * Read the "is a turn running?" probe for quit protection. A probe that throws is an unknown
 * state, and every quit path treats unknown as busy: confirming once too often is recoverable,
 * silently killing a running task is not.
 */
export function readActiveTurnForQuit(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return true;
  }
}

/** Side effects for the single active-turn quit guard shared by every app-quit entry point. */
export interface ActiveTurnQuitGuardDependencies {
  /** Raw busy probe; a throw is handled by {@link readActiveTurnForQuit}. */
  hasActiveTurn(): boolean;
  confirmQuit(): boolean;
  quit(): void;
}

export interface ActiveTurnQuitGuardOptions {
  /**
   * The main-window renderer already asked main for the busy state and, when busy, the user
   * confirmed in its own dialog. Skips the native confirmation so one close never prompts twice.
   */
  activeTurnChecked?: boolean;
}

/** Quit directly while idle, but require explicit confirmation during an active turn. */
export function requestActiveTurnGuardedQuit(
  deps: ActiveTurnQuitGuardDependencies,
  options: ActiveTurnQuitGuardOptions = {},
): void {
  if (
    !options.activeTurnChecked &&
    readActiveTurnForQuit(() => deps.hasActiveTurn()) &&
    !deps.confirmQuit()
  ) {
    return;
  }
  deps.quit();
}

/**
 * Bind the guard's side effects once and ignore quit requests while its confirmation is open.
 * A synchronous native message box runs a nested message loop on Windows, so another Alt+F4,
 * taskbar close or tray Quit can re-enter the guard from inside confirmQuit; it must neither
 * stack a second dialog nor quit underneath the one the user is still answering.
 */
export function createActiveTurnQuitGuard(
  deps: ActiveTurnQuitGuardDependencies,
): ActiveTurnQuitGuardDependencies {
  let confirming = false;
  return {
    hasActiveTurn: () => deps.hasActiveTurn(),
    confirmQuit: () => {
      if (confirming) return false;
      confirming = true;
      try {
        return deps.confirmQuit();
      } finally {
        confirming = false;
      }
    },
    quit: () => {
      if (!confirming) deps.quit();
    },
  };
}

/** Platform policy inputs for a Windows / Linux main-window close request. */
export interface MainWindowCloseRequestDependencies {
  platform: NodeJS.Platform;
  readWindowsCloseBehavior(): WindowsCloseBehavior | null;
  readLinuxCloseBehavior(): LinuxCloseBehavior | null;
  /** First close without a saved choice: ask, then the chooser applies the answer. */
  requestWindowsCloseBehavior(): void;
  requestLinuxCloseBehavior(): void;
  hideToTray(): void;
  minimize(): void;
  quitGuard: ActiveTurnQuitGuardDependencies;
}

/**
 * Apply the main window's close policy for native closes (Alt+F4, taskbar, window manager) and
 * the custom title-bar X alike. macOS hide-on-close stays with the Electron adapter.
 */
export function handleMainWindowCloseRequest(
  deps: MainWindowCloseRequestDependencies,
  options: ActiveTurnQuitGuardOptions = {},
): void {
  const quit = (): void => requestActiveTurnGuardedQuit(deps.quitGuard, options);
  if (deps.platform === 'win32') {
    const behavior = deps.readWindowsCloseBehavior();
    if (!behavior) {
      deps.requestWindowsCloseBehavior();
    } else if (behavior === 'tray') {
      deps.hideToTray();
    } else {
      quit();
    }
    return;
  }
  if (deps.platform === 'linux') {
    const behavior = deps.readLinuxCloseBehavior();
    if (!behavior) {
      deps.requestLinuxCloseBehavior();
      return;
    }
    applyLinuxMainWindowCloseBehavior({ minimize: deps.minimize }, behavior, quit, deps.minimize);
    return;
  }
  quit();
}

/** Only the latest pending fullscreen hide may change a window's visibility. */
const pendingHides = new WeakMap<object, () => void>();

export function cancelPendingWindowHide(window: object): void {
  pendingHides.get(window)?.();
}

interface MinimizableWindow extends LinuxCloseBehaviorWindow, WindowsTrayWindow {
  once(event: 'leave-full-screen' | 'show' | 'focus' | 'closed', listener: () => void): unknown;
  removeListener(
    event: 'leave-full-screen' | 'show' | 'focus' | 'closed',
    listener: () => void,
  ): unknown;
}

/** Hyprland has no native minimize surface, including for XWayland windows. */
export function isHyprlandDesktop(env: NodeJS.ProcessEnv): boolean {
  const desktop =
    env.XDG_CURRENT_DESKTOP?.trim() ||
    env.XDG_SESSION_DESKTOP?.trim() ||
    env.DESKTOP_SESSION?.trim();
  if (desktop) {
    return desktop.split(':').some((name) => name.trim().toLowerCase() === 'hyprland');
  }
  return Boolean(env.HYPRLAND_INSTANCE_SIGNATURE?.trim());
}

/** Keep all main-window minimize entry points on the same compositor policy. */
export function minimizeDesktopWindow(
  window: MinimizableWindow,
  options: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    isMainWindow: boolean;
    ensureTray(): boolean;
    onTrayError(): void;
  },
): void {
  cancelPendingWindowHide(window);
  if (options.platform !== 'linux' || !options.isMainWindow || !isHyprlandDesktop(options.env)) {
    window.minimize();
    return;
  }
  if (!options.ensureTray()) {
    options.onTrayError();
    return;
  }
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }
  const cancel = (): void => {
    if (pendingHides.get(window) === cancel) pendingHides.delete(window);
    window.removeListener('leave-full-screen', hide);
    for (const event of ['show', 'focus', 'closed'] as const) window.removeListener(event, cancel);
  };
  const hide = (): void => {
    if (pendingHides.get(window) !== cancel) return;
    cancel();
    if (!window.isDestroyed()) window.hide();
  };
  pendingHides.set(window, cancel);
  window.once('leave-full-screen', hide);
  for (const event of ['show', 'focus', 'closed'] as const) window.once(event, cancel);
  try {
    window.setFullScreen(false);
  } catch (error) {
    cancel();
    throw error;
  }
}

/** BrowserWindow surface needed for Linux's keep-running close action. */
export interface LinuxCloseBehaviorWindow {
  minimize(): void;
}

/** Apply the persisted Linux choice without coupling the policy to Electron globals. */
export function applyLinuxMainWindowCloseBehavior(
  window: LinuxCloseBehaviorWindow,
  behavior: LinuxCloseBehavior,
  quit: () => void,
  keepRunning: () => void = () => window.minimize(),
): void {
  if (behavior === 'minimize') {
    keepRunning();
  } else {
    quit();
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
  cancelPendingWindowHide(window);
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
