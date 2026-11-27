import type { BrowserWindow, Rectangle } from 'electron';
import {
  placeOntoLiveDisplay,
  rectInsideWorkArea,
  windowStateView,
  type WorkAreaScreen,
} from './mainWindowWorkAreaBounds';

/** Per-window, temporary geometry only; never changes the saved panel proportions. */
export class SidebarWindowExpansion {
  private readonly expanded = new WeakMap<BrowserWindow, { before: Rectangle; after: Rectangle; contained: boolean }>();

  // The expanded width and the standalone rectangle are independent user states.
  // Keep this across sidebar toggles, but let destroyed windows release it.
  private readonly lastExpandedWidth = new WeakMap<BrowserWindow, number>();

  /**
   * Persist the standalone rectangle even while the combined window is open.
   * `getLiveBounds` stays the real window so Snap / work-area fill detection still
   * sees it; our own expansion (live equals what we set) reads as the baseline.
   */
  persistenceView(win: BrowserWindow, screenApi?: WorkAreaScreen) {
    const open = () => this.expanded.get(win);
    return {
      ...windowStateView(win, () => {
        const state = open();
        return state ? standaloneTarget(state, win.getBounds(), screenApi) : win.getBounds();
      }),
      getLiveBounds: () => {
        const live = win.getBounds();
        const state = open();
        const ours = state && (['x', 'y', 'width', 'height'] as const).every((k) => live[k] === state.after[k]);
        return ours ? state.before : live;
      },
    };
  }

  update(win: BrowserWindow, requested: number, workArea: Rectangle, screenApi?: WorkAreaScreen): number {
    const previous = this.expanded.get(win);
    if (requested === 0) this.expanded.delete(win);
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen()) return 0;
    const bounds = win.getBounds();
    if (requested === 0) {
      if (previous) {
        this.lastExpandedWidth.set(win, bounds.width);
        // Divider and native-window size edits while open are temporary allocation only,
        // but a window the user dragged stays where it was dragged to.
        win.setBounds(standaloneTarget(previous, bounds, screenApi));
      }
      return win.getBounds().width - bounds.width;
    }
    if (previous) return 0;
    const room = Math.max(0, workArea.x + workArea.width - bounds.x - bounds.width);
    const targetWidth = this.lastExpandedWidth.get(win) ?? bounds.width + requested;
    const growth = Math.min(Math.ceil(targetWidth - bounds.width), room);
    // Record before setBounds: native resize listeners may persist synchronously.
    const state = { before: bounds, after: bounds, contained: rectInsideWorkArea(bounds, workArea) };
    this.expanded.set(win, state);
    if (growth !== 0) win.setBounds({ ...bounds, width: bounds.width + growth });
    const after = win.getBounds();
    state.after = after;
    return after.width - bounds.width;
  }
}

/**
 * The standalone rectangle to return to: the size from before opening, moved by
 * however far the user dragged the combined window while the sidebar was open.
 */
function standaloneTarget(
  state: { before: Rectangle; after: Rectangle; contained: boolean },
  live: Rectangle,
  screenApi?: WorkAreaScreen,
): Rectangle {
  const target = {
    ...state.before,
    x: state.before.x + live.x - state.after.x,
    y: state.before.y + live.y - state.after.y,
  };
  // Closing and saving must agree even after a drag, resize or display removal.
  // Preserve intentionally off-screen baselines; only repair formerly contained ones.
  const home = screenApi?.getDisplayMatching(target).workArea;
  return screenApi && home && state.contained && !rectInsideWorkArea(target, home)
    ? placeOntoLiveDisplay(target, target, screenApi)
    : target;
}

/** Shared by native IPC and the main-window state keeper. */
export const sidebarWindowExpansion = new SidebarWindowExpansion();
