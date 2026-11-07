import type { BrowserWindow, Rectangle } from 'electron';

/** Per-window, temporary geometry only; never changes the saved panel proportions. */
export class SidebarWindowExpansion {
  private readonly expanded = new WeakMap<BrowserWindow, { before: Rectangle; after: Rectangle }>();

  /** A restored open sidebar is already part of the saved native window bounds. */
  adopt(win: BrowserWindow, sidebarSpace: number): number {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen()) return 0;
    const bounds = win.getBounds();
    const existing = this.expanded.get(win);
    if (existing) return Math.max(0, bounds.width - existing.before.width);
    const growth = Math.min(sidebarSpace, Math.max(0, bounds.width - 400));
    this.expanded.set(win, { before: { ...bounds, width: bounds.width - growth }, after: bounds });
    return growth;
  }

  update(win: BrowserWindow, requested: number, workArea: Rectangle, shrink?: number): number {
    const previous = this.expanded.get(win);
    if (requested === 0) this.expanded.delete(win);
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen()) return 0;
    const bounds = win.getBounds();
    if (requested === 0) {
      if (previous) {
        // Sidebar geometry owns the horizontal delta; retain the user's position and height.
        const width = shrink === undefined ? previous.before.width : Math.max(400, bounds.width - shrink);
        if (width !== bounds.width) win.setBounds({ ...bounds, width });
      }
      return win.getBounds().width - bounds.width;
    }
    if (previous) return 0;
    const room = Math.max(0, workArea.x + workArea.width - bounds.x - bounds.width);
    const growth = Math.min(Math.ceil(requested), room);
    if (growth > 0) win.setBounds({ ...bounds, width: bounds.width + growth });
    const after = win.getBounds();
    this.expanded.set(win, { before: bounds, after });
    return after.width - bounds.width;
  }
}
