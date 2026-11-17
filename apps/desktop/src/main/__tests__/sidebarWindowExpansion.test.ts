/** Unit regression: SidebarWindowExpansion must preserve chat geometry across open/close,
 * display limits and restored windows. No prior controller covered this new native behavior;
 * minimal inputs are a 900px window, a bounded work area and a manual sidebar delta.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { manageWindowStatePreservingNormalBounds, type PersistableWindow } from '../mainWindowWorkAreaBounds';
import { SidebarWindowExpansion } from '../sidebarWindowExpansion';

function fixture() {
  let bounds = { x: -1600, y: 40, width: 900, height: 800 };
  const win = {
    isDestroyed: () => false, isMinimized: () => false, isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false), isSimpleFullScreen: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((next: typeof bounds) => { bounds = next; }),
  };
  return { win, native: win as unknown as BrowserWindow,
    area: { x: -1920, y: 0, width: 1920, height: 1080 } };
}

describe('sidebar window expansion', () => {
  it('grows only to the current display edge and restores on close', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(native, 900, area);
    expect(win.getBounds()).toEqual({ x: -1600, y: 40, width: 1600, height: 800 });
    controller.update(native, 900, area);
    expect(win.setBounds).toHaveBeenCalledTimes(1);
    controller.update(native, 0, area);
    expect(win.getBounds().width).toBe(900);
  });
  it('restores the standalone rectangle after edits while open and isolates windows', () => {
    const a = fixture(); const b = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(a.native, 400, a.area);
    a.win.setBounds({ x: -1400, y: 90, width: 1200, height: 850 });
    controller.update(b.native, 0, b.area);
    controller.update(a.native, 0, a.area);
    expect(a.win.getBounds()).toEqual({ x: -1600, y: 40, width: 900, height: 800 });
    expect(b.win.setBounds).not.toHaveBeenCalled();
  });
  // Unit regression: #9661 restored standalone geometry but reopening used the
  // newly saved sidebar width as new native growth. A 1300px combined window
  // must stay 1300px after the divider changes the request from 400px to 600px.
  it('restores the last expanded width independently of the divider and standalone bounds', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(native, 400, area);
    controller.update(native, 0, area);
    expect(win.getBounds().width).toBe(900);
    controller.update(native, 600, area);
    expect(win.getBounds().width).toBe(1300);
    // Native resizing while open updates the separate expanded state.
    win.setBounds({ ...win.getBounds(), width: 1400 });
    controller.update(native, 0, area);
    expect(win.getBounds().width).toBe(900);
    // A standalone edit remains the new close target, not the expanded target.
    win.setBounds({ ...win.getBounds(), width: 1500 });
    controller.update(native, 500, area);
    expect(win.getBounds().width).toBe(1400);
    controller.update(native, 0, area);
    expect(win.getBounds().width).toBe(1500);
  });
  it('keeps remembered expanded width per window and respects the current display edge', () => {
    const a = fixture(); const b = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(a.native, 600, a.area);
    controller.update(a.native, 0, a.area);
    controller.update(b.native, 200, b.area);
    expect(b.win.getBounds().width).toBe(1100);
    a.win.setBounds({ x: -1200, y: 40, width: 900, height: 800 });
    controller.update(a.native, 200, a.area);
    expect(a.win.getBounds().width).toBe(1200);
    controller.update(a.native, 0, a.area);
    expect(a.win.getBounds()).toEqual({ x: -1200, y: 40, width: 900, height: 800 });
  });
  it('leaves maximized/fullscreen windows alone', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    win.isMaximized.mockReturnValue(true);
    controller.update(native, 500, area);
    win.isMaximized.mockReturnValue(false);
    win.isFullScreen.mockReturnValue(true);
    controller.update(native, 500, area);
    expect(win.setBounds).not.toHaveBeenCalled();
  });
  // Unit regression: divider redistribution used to change the close width. The
  // keeper must also retain the baseline when quitting with the sidebar open.
  it('persists only standalone edits and reopens without cumulative geometry drift', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    const saved = controller.persistenceView(native);
    const before = win.getBounds();
    controller.update(native, 400, area);
    expect(saved.getBounds()).toEqual(before);
    win.setBounds({ x: -1500, y: 90, width: 1500, height: 850 });
    expect(saved.getBounds()).toEqual(before);
    controller.update(native, 0, area);
    expect(win.getBounds()).toEqual(before);
    const edited = { x: -1500, y: 60, width: 1000, height: 850 };
    win.setBounds(edited);
    expect(saved.getBounds()).toEqual(edited);
    controller.update(native, 500, area);
    expect(saved.getBounds()).toEqual(edited);
    controller.update(native, 0, area);
    expect(win.getBounds()).toEqual(edited);
  });
  it.each(['darwin', 'win32'] as const)('keeps the persisted baseline through a restart on %s', (platform) => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    let keeper!: PersistableWindow;
    manageWindowStatePreservingNormalBounds(
      { manage: (view) => { keeper = view; } },
      controller.persistenceView(native),
      { getDisplayMatching: () => ({ bounds: area, workArea: area }) },
      platform,
    );
    const before = win.getBounds();
    win.setBounds.mockImplementation((next) => {
      // Native resize persistence must see the baseline even during setBounds.
      expect(keeper.getBounds()).toEqual(before);
      win.getBounds = () => ({ ...next });
    });
    controller.update(native, 400, area);
    const stored = keeper.getBounds();
    expect(stored).toEqual(before);
    const restarted = fixture();
    restarted.win.setBounds(stored);
    const fresh = new SidebarWindowExpansion();
    fresh.update(restarted.native, 600, area);
    fresh.update(restarted.native, 0, area);
    expect(restarted.win.getBounds()).toEqual(before);
  });
  it('tracks user-added width even when opening had no space to expand', () => {
    const { win, native, area } = fixture();
    win.setBounds({ x: -900, y: 40, width: 900, height: 800 });
    const controller = new SidebarWindowExpansion();
    expect(controller.update(native, 400, area)).toBe(0);
    win.setBounds({ x: -1200, y: 40, width: 1100, height: 800 });
    controller.update(native, 0, area);
    expect(win.getBounds().width).toBe(900);
  });
  // Review regression: the baseline view must not hide a real work-area fill.
  it('still reports a Snap fill while open, but not its own expansion', () => {
    const { win, native, area } = fixture();
    win.setBounds({ x: -1920, y: 0, width: 960, height: 1080 });
    const controller = new SidebarWindowExpansion();
    let keeper!: PersistableWindow;
    manageWindowStatePreservingNormalBounds(
      { manage: (view) => { keeper = view; } },
      controller.persistenceView(native),
      { getDisplayMatching: () => ({ bounds: area, workArea: area }) },
      'win32',
    );
    const before = win.getBounds();
    // Full-height window at the left edge grows to the work-area edge by itself.
    controller.update(native, 960, area);
    expect(win.getBounds()).toEqual(area);
    expect(keeper.isMaximized()).toBe(false);
    expect(keeper.getBounds()).toEqual(before);
    // The user then snaps it to fill: that is a real maximize to restore.
    win.setBounds({ x: -1919, y: 1, width: 1918, height: 1079 });
    expect(keeper.isMaximized()).toBe(true);
    expect(keeper.getBounds()).toEqual(before);
  });
  it('keeps a removed display off-screen rectangle inside the work area on close', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(native, 400, area);
    const remaining = { x: 0, y: 0, width: 1280, height: 720 };
    win.setBounds({ x: 100, y: 50, width: 1300, height: 700 });
    const screenApi = { getPrimaryDisplay: () => ({ bounds: remaining, workArea: remaining }),
      getDisplayMatching: () => ({ bounds: remaining, workArea: remaining }) };
    controller.update(native, 0, remaining, screenApi);
    const restored = win.getBounds();
    expect(restored.x).toBeGreaterThanOrEqual(0);
    expect(restored.x + restored.width).toBeLessThanOrEqual(1280);
    expect(restored.width).toBe(900);
  });
  it('returns to the original connected display when the window was moved to another one', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(native, 400, area);
    const other = { x: 0, y: 0, width: 1920, height: 1080 };
    win.setBounds({ x: 300, y: 50, width: 1300, height: 700 });
    const screenApi = { getPrimaryDisplay: () => ({ bounds: area, workArea: area }),
      getDisplayMatching: (r: { x: number }) => { const d = r.x < 0 ? area : other; return { bounds: d, workArea: d }; } };
    controller.update(native, 0, other, screenApi);
    expect(win.getBounds()).toEqual({ x: -1600, y: 40, width: 900, height: 800 });
  });
});
