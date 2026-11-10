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
});
