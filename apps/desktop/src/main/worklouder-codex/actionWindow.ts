import type { WorkLouderCodexRendererAction } from '../../shared/workLouderCodex.js';

export interface WorkLouderCodexActionWindowLike {
  isDestroyed(): boolean;
  webContents?: {
    isDestroyed(): boolean;
    isLoading(): boolean;
  };
}

export type WorkLouderCodexActionWindowTarget = 'task-switch' | 'active-window' | 'system-frontmost';

/**
 * Task switching stays on the primary Cindy window so the six task keys keep
 * one stable owner. Voice, send, and scroll follow the focused Cindy window
 * when Cindy is frontmost; otherwise they go to the system frontmost app.
 */
const TASK_SWITCH_COMMANDS = new Set(['session.selectPrevious', 'session.selectNext']);
const SYSTEM_FRONTMOST_COMMANDS = new Set(['composer.submit']);

export function workLouderCodexActionWindowTarget(
  action: WorkLouderCodexRendererAction,
): WorkLouderCodexActionWindowTarget {
  if (action.type === 'command' && TASK_SWITCH_COMMANDS.has(action.commandId)) {
    return 'task-switch';
  }
  if (
    action.type === 'voice' ||
    action.type === 'scroll' ||
    action.type === 'scroll-stop' ||
    (action.type === 'command' && SYSTEM_FRONTMOST_COMMANDS.has(action.commandId))
  ) {
    return 'system-frontmost';
  }
  return 'active-window';
}

export function isSendableWorkLouderCodexWindow(
  win: WorkLouderCodexActionWindowLike | null | undefined,
): win is WorkLouderCodexActionWindowLike {
  return Boolean(
    win &&
      !win.isDestroyed() &&
      win.webContents &&
      !win.webContents.isDestroyed() &&
      !win.webContents.isLoading(),
  );
}

function isHeldGestureStart(action: WorkLouderCodexRendererAction): boolean {
  return (action.type === 'voice' && action.phase === 'press') || action.type === 'scroll';
}

function isHeldGestureEnd(action: WorkLouderCodexRendererAction): boolean {
  return (action.type === 'voice' && action.phase === 'release') || action.type === 'scroll-stop';
}

/**
 * Sticky held gestures stay on the window that received the press. A focus
 * change mid-hold must not split press and release across two composers.
 */
export function createWorkLouderCodexActiveWindowRouter<
  TWindow extends WorkLouderCodexActionWindowLike,
>(deps: {
  getFocusedWindow: () => TWindow | null;
  getMainWindow: () => TWindow | null;
  isActionWindow: (win: TWindow | null | undefined) => boolean;
}) {
  let heldWindow: TWindow | null = null;
  let heldOnSystemFrontmost = false;

  function isUsableActionWindow(win: TWindow | null | undefined): win is TWindow {
    return isSendableWorkLouderCodexWindow(win) && deps.isActionWindow(win);
  }

  function resolveFocusedCindyWindow(): TWindow | null {
    const focused = deps.getFocusedWindow();
    return isUsableActionWindow(focused) ? focused : null;
  }

  function resolveActiveCindyWindow(): TWindow | null {
    return resolveFocusedCindyWindow() ?? (() => {
      const main = deps.getMainWindow();
      return isUsableActionWindow(main) ? main : null;
    })();
  }

  function resolveHeldOrFocusedCindyWindow(): TWindow | null {
    if (isUsableActionWindow(heldWindow)) return heldWindow;
    heldWindow = null;
    return resolveFocusedCindyWindow();
  }

  return {
    resolve(action: WorkLouderCodexRendererAction): TWindow | null {
      const target = workLouderCodexActionWindowTarget(action);
      if (target === 'task-switch') {
        const main = deps.getMainWindow();
        return isSendableWorkLouderCodexWindow(main) ? main : null;
      }

      const stayOnCindy = target !== 'system-frontmost';
      if (isHeldGestureStart(action)) {
        if (heldOnSystemFrontmost) return null;
        const win = stayOnCindy ? resolveActiveCindyWindow() : resolveHeldOrFocusedCindyWindow();
        if (win) {
          heldWindow = win;
          heldOnSystemFrontmost = false;
          return win;
        }
        if (!stayOnCindy) {
          heldOnSystemFrontmost = true;
          heldWindow = null;
        }
        return null;
      }
      if (isHeldGestureEnd(action)) {
        if (heldOnSystemFrontmost) {
          heldOnSystemFrontmost = false;
          heldWindow = null;
          return null;
        }
        const win = resolveHeldOrFocusedCindyWindow();
        heldWindow = null;
        heldOnSystemFrontmost = false;
        return win;
      }

      return stayOnCindy ? resolveActiveCindyWindow() : resolveFocusedCindyWindow();
    },
  };
}
