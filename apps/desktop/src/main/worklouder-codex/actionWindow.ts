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

type HeldGesture = 'voice' | 'scroll';

function heldGestureFor(action: WorkLouderCodexRendererAction): HeldGesture | null {
  if (action.type === 'voice') return 'voice';
  if (action.type === 'scroll' || action.type === 'scroll-stop') return 'scroll';
  return null;
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
 * Voice and scroll keep independent slots so one finishing cannot steal the
 * other's target.
 */
export function createWorkLouderCodexActiveWindowRouter<
  TWindow extends WorkLouderCodexActionWindowLike,
>(deps: {
  getFocusedWindow: () => TWindow | null;
  getMainWindow: () => TWindow | null;
  isActionWindow: (win: TWindow | null | undefined) => boolean;
}) {
  const held = {
    voice: { window: null as TWindow | null, onSystemFrontmost: false },
    scroll: { window: null as TWindow | null, onSystemFrontmost: false },
  };

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

  function resolveHeldOrFocusedCindyWindow(gesture: HeldGesture): TWindow | null {
    const slot = held[gesture];
    if (isUsableActionWindow(slot.window)) return slot.window;
    slot.window = null;
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
      const gesture = heldGestureFor(action);
      if (gesture && isHeldGestureStart(action)) {
        const slot = held[gesture];
        if (slot.onSystemFrontmost) return null;
        const win = stayOnCindy ? resolveActiveCindyWindow() : resolveHeldOrFocusedCindyWindow(gesture);
        if (win) {
          slot.window = win;
          slot.onSystemFrontmost = false;
          return win;
        }
        if (!stayOnCindy) {
          slot.onSystemFrontmost = true;
          slot.window = null;
        }
        return null;
      }
      if (gesture && isHeldGestureEnd(action)) {
        const slot = held[gesture];
        if (slot.onSystemFrontmost) {
          slot.onSystemFrontmost = false;
          slot.window = null;
          return null;
        }
        const win = resolveHeldOrFocusedCindyWindow(gesture);
        slot.window = null;
        slot.onSystemFrontmost = false;
        return win;
      }

      return stayOnCindy ? resolveActiveCindyWindow() : resolveFocusedCindyWindow();
    },
  };
}
