import type {
  LinuxCloseBehavior,
  TitleBarQuitOutcome,
  WindowsCloseBehavior,
} from '../shared/windowBehavior.js';
import type { WindowsTrayWindow } from './windowsTrayLifecycle.js';

/**
 * Read the "is a turn running?" probe for quit protection. A probe that throws is an unknown
 * state, and every quit path treats unknown as busy: confirming once too often is recoverable,
 * silently killing a running task is not.
 */
function readActiveTurnForQuit(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return true;
  }
}

/** Side effects for the single active-turn quit guard shared by every app-quit entry point. */
export interface ActiveTurnQuitGuardDependencies<TOwner> {
  /** Raw busy probe; a throw is handled by {@link readActiveTurnForQuit}. */
  hasActiveTurn(): boolean;
  /** Main's own (native, synchronous) confirmation; true when the user chose to quit. */
  confirmQuit(): boolean;
  quit(): void;
  /**
   * Whether the user can be looking at the in-app confirmation drawn by `owner` (the main
   * window's renderer): its window is shown and not minimized, and the renderer is alive and responsive.
   */
  canShowInAppConfirmation(owner: TOwner): boolean;
  /** Bring `owner`'s window to the front so the user finds the confirmation already open. */
  revealInAppConfirmation(owner: TOwner): void;
}

/**
 * Main owns every quit confirmation. The title-bar X draws its confirmation in the renderer,
 * but main decides whether one is needed and remembers that it asked; the renderer's answer
 * only counts against that record.
 */
export interface ActiveTurnQuitGuard<TOwner> {
  /**
   * Tray Quit, native main-window close (Alt+F4, taskbar, window manager), the first-close
   * chooser and any quit whose sender cannot be resolved. Returns true when it quit.
   */
  requestQuit(): boolean;
  /**
   * Title-bar X of the main window. Reads the busy state and acts on it in the same call:
   * idle quits now ('quitting'); busy records a pending in-app confirmation for `owner`
   * ('confirm'). 'none' when main's own confirmation is already open.
   */
  requestInAppQuit(owner: TOwner): TitleBarQuitOutcome;
  /**
   * The answer from `owner`'s in-app confirmation. A confirmation quits without asking again
   * only when main holds the pending record for that same owner, which it consumes; otherwise
   * main runs its own guard. A cancellation drops the record.
   */
  resolveInAppConfirmation(owner: TOwner, confirmed: boolean): TitleBarQuitOutcome;
  /** `owner` can no longer be showing its confirmation (navigation, crash, hang, destroyed). */
  dropInAppConfirmation(owner: TOwner): void;
}

/**
 * Bind the guard's side effects once. Two confirmations never stack:
 * - While main's native confirmation is open, every other quit request is ignored. A
 *   synchronous message box runs a nested message loop on Windows, so another Alt+F4, taskbar
 *   close or tray Quit can re-enter from inside confirmQuit; it must neither stack a second
 *   dialog nor quit underneath the one the user is still answering.
 * - While an in-app confirmation is pending and visible, the other routes only bring it to the
 *   front. If the user cannot be looking at it (window hidden, minimized or gone, renderer
 *   dead or hung), the record is dropped and the route falls back to the native
 *   confirmation, so a pending record can never make the app unquittable.
 */
export function createActiveTurnQuitGuard<TOwner>(
  deps: ActiveTurnQuitGuardDependencies<TOwner>,
): ActiveTurnQuitGuard<TOwner> {
  let confirming = false;
  let pending: { owner: TOwner } | null = null;

  const quit = (): void => {
    pending = null;
    deps.quit();
  };

  const requestQuit = (): boolean => {
    if (confirming) return false;
    if (pending) {
      if (deps.canShowInAppConfirmation(pending.owner)) {
        deps.revealInAppConfirmation(pending.owner);
        return false;
      }
      pending = null;
    }
    if (readActiveTurnForQuit(() => deps.hasActiveTurn())) {
      confirming = true;
      let confirmed: boolean;
      try {
        confirmed = deps.confirmQuit();
      } finally {
        confirming = false;
      }
      if (!confirmed) return false;
    }
    quit();
    return true;
  };

  return {
    requestQuit,
    requestInAppQuit(owner) {
      if (confirming) return 'none';
      if (readActiveTurnForQuit(() => deps.hasActiveTurn())) {
        pending = { owner };
        return 'confirm';
      }
      quit();
      return 'quitting';
    },
    resolveInAppConfirmation(owner, confirmed) {
      if (!confirmed) {
        if (pending?.owner === owner) pending = null;
        return 'none';
      }
      if (pending?.owner === owner) {
        quit();
        return 'quitting';
      }
      return requestQuit() ? 'quitting' : 'none';
    },
    dropInAppConfirmation(owner) {
      if (pending?.owner === owner) pending = null;
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
}

/**
 * Apply the main window's close policy for native closes (Alt+F4, taskbar, window manager) and
 * the custom title-bar X alike; `quit` is the guarded quit of the calling route. macOS
 * hide-on-close stays with the Electron adapter.
 */
export function handleMainWindowCloseRequest(
  deps: MainWindowCloseRequestDependencies,
  quit: () => void,
): void {
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

/**
 * Bring the main window to the front so the user sees a dialog it shows: drop a pending
 * fullscreen hide, restore it if minimized, show it if hidden, then focus it.
 */
export function revealMainWindow(window: Omit<MainWindowClosePromptWindow, 'webContents'>): void {
  cancelPendingWindowHide(window);
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/** Keep the main window visible and ask its renderer to show the platform chooser. */
export function requestMainWindowCloseBehavior(
  window: MainWindowClosePromptWindow,
  channel: string,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  revealMainWindow(window);
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
