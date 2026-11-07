/** Unit regression: SidebarWindowExpansion must preserve chat geometry across open/close,
 * display limits and restored windows. No prior controller covered this new native behavior;
 * minimal inputs are a 900px window, a bounded work area and a manual sidebar delta.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { SidebarWindowExpansion } from '../sidebarWindowExpansion';

function fixture() {
  let bounds = { x: -1600, y: 40, width: 900, height: 800 };
  const win = {
    isDestroyed: () => false, isMaximized: vi.fn(() => false),
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
  it('retracts the resized sidebar while preserving position/height and isolating windows', () => {
    const a = fixture(); const b = fixture();
    const controller = new SidebarWindowExpansion();
    controller.update(a.native, 400, a.area);
    a.win.setBounds({ x: -1400, y: 90, width: 1200, height: 850 });
    controller.update(b.native, 0, b.area);
    controller.update(a.native, 0, a.area, 300);
    expect(a.win.getBounds()).toEqual({ x: -1400, y: 90, width: 900, height: 850 });
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
  it('adopts restored bounds without growing again, and retracts on close', () => {
    const { win, native, area } = fixture();
    const controller = new SidebarWindowExpansion();
    expect(controller.adopt(native, 301)).toBe(301);
    expect(controller.adopt(native, 301)).toBe(301);
    expect(win.setBounds).not.toHaveBeenCalled();
    controller.update(native, 0, area, 301);
    expect(win.getBounds().width).toBe(599);
    controller.update(native, 301, area);
    expect(win.getBounds().width).toBe(900);
  });
  it('tracks user-added width even when opening had no space to expand', () => {
    const { win, native, area } = fixture();
    win.setBounds({ x: -900, y: 40, width: 900, height: 800 });
    const controller = new SidebarWindowExpansion();
    expect(controller.update(native, 400, area)).toBe(0);
    win.setBounds({ x: -1200, y: 40, width: 1100, height: 800 });
    controller.update(native, 0, area, 200);
    expect(win.getBounds().width).toBe(900);
  });
});
