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
  persistenceView(win: BrowserWindow) {
    const open = () => this.expanded.get(win);
    return {
      ...windowStateView(win, () => open()?.before ?? win.getBounds()),
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
        // Divider and native-window edits while open are temporary allocation only.
        // A display removed or shrunk while open can leave the old rectangle off-screen.
        // Judge it against the display it belongs to, not the one the window is on now:
        // a window moved to another connected display still returns to where it was.
        const home = screenApi?.getDisplayMatching(previous.before).workArea;
        win.setBounds(
          screenApi && home && previous.contained && !rectInsideWorkArea(previous.before, home)
            ? placeOntoLiveDisplay(previous.before, previous.before, screenApi)
            : previous.before,
        );
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

/** Shared by native IPC and the main-window state keeper. */
export const sidebarWindowExpansion = new SidebarWindowExpansion();
