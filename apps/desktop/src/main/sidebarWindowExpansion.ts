import type { BrowserWindow, Rectangle } from 'electron';
import { windowStateView } from './mainWindowWorkAreaBounds';

/** Per-window, temporary geometry only; never changes the saved panel proportions. */
export class SidebarWindowExpansion {
  private readonly expanded = new WeakMap<BrowserWindow, { before: Rectangle }>();

  /** Persist the standalone rectangle even while the combined window is open. */
  persistenceView(win: BrowserWindow) {
    return windowStateView(win, () => this.expanded.get(win)?.before ?? win.getBounds());
  }

  update(win: BrowserWindow, requested: number, workArea: Rectangle): number {
    const previous = this.expanded.get(win);
    if (requested === 0) this.expanded.delete(win);
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen()) return 0;
    const bounds = win.getBounds();
    if (requested === 0) {
      if (previous) {
        // Divider and native-window edits while open are temporary allocation only.
        win.setBounds(previous.before);
      }
      return win.getBounds().width - bounds.width;
    }
    if (previous) return 0;
    const room = Math.max(0, workArea.x + workArea.width - bounds.x - bounds.width);
    const growth = Math.min(Math.ceil(requested), room);
    // Record before setBounds: native resize listeners may persist synchronously.
    this.expanded.set(win, { before: bounds });
    if (growth > 0) win.setBounds({ ...bounds, width: bounds.width + growth });
    const after = win.getBounds();
    return after.width - bounds.width;
  }
}

/** Shared by native IPC and the main-window state keeper. */
export const sidebarWindowExpansion = new SidebarWindowExpansion();
