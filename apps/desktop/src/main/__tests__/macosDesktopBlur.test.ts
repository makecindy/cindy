import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applyMacWindowBackdrop, refreshMacSidebarGeometry, setMacSidebarWidth } from '../macosDesktopBlur';

// Unit regression for the nonzero -> nonzero slider bug: exercise the production
// dispatcher, preserving radius and window identity. The existing resolver tests
// do not invoke native application. Real CGS behavior belongs to desktop-blur.verify.mjs.
const windowFixture = () => {
  const handle = Buffer.alloc(8);
  return {
    isDestroyed: vi.fn(() => false),
    setVibrancy: vi.fn(),
    setBackgroundColor: vi.fn(),
    getNativeWindowHandle: vi.fn(() => handle),
    webContents: { getZoomFactor: vi.fn(() => 1) },
    getContentBounds: vi.fn(() => ({ width: 1280, height: 800 })),
  };
};
describe('Mac desktop blur application', () => {
  // Performance contract: identical updates and radius-only changes must preserve
  // the existing native sidebar, mask and rounded-window backing. Unit tier;
  // earlier tests checked radius routing but could not catch material recreation.
  it('updates only changed native properties and retains the sidebar through radius changes', () => {
    const first = windowFixture();
    const win = first as unknown as BrowserWindow;
    const native = { apply: vi.fn(() => true), setSidebar: vi.fn(() => true) };
    const load = () => native;
    const config = { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 5,
      sidebarMaterial: 'light' as const };
    setMacSidebarWidth(win, 260, load);
    applyMacWindowBackdrop(win, config, load);
    for (let i = 0; i < 100; i++) applyMacWindowBackdrop(win, { ...config }, load);
    expect(native.apply).toHaveBeenCalledTimes(1);
    expect(native.setSidebar).toHaveBeenCalledTimes(1);
    expect(first.setBackgroundColor).toHaveBeenCalledTimes(1);
    const materialCalls = first.setVibrancy.mock.calls.length;
    applyMacWindowBackdrop(win, { ...config, desktopBlurRadius: 20 }, load);
    expect(native.apply).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 20);
    expect(native.setSidebar).toHaveBeenCalledTimes(1);
    expect(first.setVibrancy).toHaveBeenCalledTimes(materialCalls);
    setMacSidebarWidth(win, 260, load);
    expect(native.setSidebar).toHaveBeenCalledTimes(1);
    first.webContents.getZoomFactor.mockReturnValue(1.25);
    applyMacWindowBackdrop(win, { ...config, desktopBlurRadius: 20, sidebarMaterial: 'dark' }, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 325, true);
    expect(first.setVibrancy).toHaveBeenCalledTimes(materialCalls);
  });
  it('passes distinct radii and clears only the affected window when artwork covers it', () => {
    const first = windowFixture(), second = windowFixture();
    const native = { apply: vi.fn((_handle: Buffer, _radius: number) => true), setSidebar: vi.fn(() => true) };
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000' };
    for (const radius of [0, 5, 17, 20, 0]) {
      applyMacWindowBackdrop(first as unknown as BrowserWindow,
        { ...config, desktopBlurRadius: radius }, () => native);
    }
    applyMacWindowBackdrop(second as unknown as BrowserWindow,
      { ...config, desktopBlurRadius: 8 }, () => native);
    applyMacWindowBackdrop(first as unknown as BrowserWindow,
      { vibrancy: null, backgroundColor: '#ffffff' }, () => native);
    expect(native.apply.mock.calls.map(call => call[1])).toEqual([0, 5, 17, 20, 0, 8, 0]);
    expect(native.apply.mock.lastCall?.[0]).toBe(first.getNativeWindowHandle.mock.results[0].value);
    expect(second.setVibrancy.mock.calls).toEqual([[null]]);
  });

  it('retains system material if the native module rejects the radius and ignores destroyed windows', () => {
    const win = windowFixture();
    const native = { apply: vi.fn((_handle: Buffer, _radius: number) => false), setSidebar: vi.fn(() => true) };
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 5 };
    applyMacWindowBackdrop(win as unknown as BrowserWindow, config, () => native);
    expect(win.setVibrancy.mock.lastCall).toEqual(['under-window']);
    native.apply.mockReturnValue(true);
    applyMacWindowBackdrop(win as unknown as BrowserWindow, config, () => native);
    expect(native.apply).toHaveBeenCalledTimes(2);
    expect(win.setVibrancy.mock.lastCall).toEqual([null]);
    win.isDestroyed.mockReturnValue(true);
    applyMacWindowBackdrop(win as unknown as BrowserWindow, config, () => native);
    expect(native.apply).toHaveBeenCalledTimes(2);
  });

  // Unit: reviewer-reported main-window path (addon missing + expanded sidebar) ended with no
  // material at all; the documented system fallback must remain. Earlier tests set no sidebar width.
  it('keeps the system material fallback when the native addon is unavailable and the sidebar is expanded', () => {
    const win = windowFixture();
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 5,
      sidebarMaterial: 'light' as const };
    setMacSidebarWidth(win as unknown as BrowserWindow, 260, () => null);
    applyMacWindowBackdrop(win as unknown as BrowserWindow, config, () => null);
    expect(win.setVibrancy.mock.lastCall).toEqual(['under-window']);
  });

  // Unit: addon loads but the radius call fails. The whole-window fallback stays and no masked
  // sidebar replaces it; page zoom must reach the native mask without a CSS width change.
  it('keeps the whole-window fallback when only the radius fails, and follows page zoom', () => {
    const win = windowFixture();
    const bw = win as unknown as BrowserWindow;
    const native = { apply: vi.fn(() => false), setSidebar: vi.fn(() => true) };
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 5,
      sidebarMaterial: 'light' as const };
    setMacSidebarWidth(bw, 260, () => native);
    applyMacWindowBackdrop(bw, config, () => native);
    expect(native.setSidebar).not.toHaveBeenCalled();
    expect(win.setVibrancy.mock.lastCall).toEqual(['under-window']);
    native.apply.mockReturnValue(true);
    applyMacWindowBackdrop(bw, config, () => native);
    expect(native.setSidebar).toHaveBeenLastCalledWith(win.getNativeWindowHandle(), 260, false);
    win.webContents.getZoomFactor.mockReturnValue(1.5);
    refreshMacSidebarGeometry(bw, () => native);
    expect(native.setSidebar).toHaveBeenLastCalledWith(win.getNativeWindowHandle(), 390, false);
  });

  it('retries a failed sidebar mask and replaces it when returning to a full system material', () => {
    const first = windowFixture();
    const win = first as unknown as BrowserWindow;
    const native = { apply: vi.fn(() => true), setSidebar: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) };
    const config = { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 0, sidebarMaterial: 'light' as const };
    setMacSidebarWidth(win, 260, () => native);
    applyMacWindowBackdrop(win, config, () => native);
    expect(first.setVibrancy.mock.lastCall).toEqual([null]);
    applyMacWindowBackdrop(win, config, () => native);
    expect(native.setSidebar).toHaveBeenCalledTimes(2);
    expect(first.setVibrancy.mock.lastCall).toEqual(['hud']);
    applyMacWindowBackdrop(win, { vibrancy: 'hud', backgroundColor: '#00000000' }, () => native);
    expect(first.setVibrancy.mock.calls.slice(-2)).toEqual([[null], ['hud']]);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 0, false);
  });

  // Unit: the retained sidebar must survive radius zero, follow only its own
  // window geometry/zoom, and release the native view under an in-app wallpaper.
  // The previous radius-only regression could not detect any of these outcomes.
  it('keeps sidebar material independent of radius and releases it on collapse or wallpaper', () => {
    const first = windowFixture(), second = windowFixture();
    const win = first as unknown as BrowserWindow;
    const native = { apply: vi.fn(() => true),
      setSidebar: vi.fn((_handle: Buffer, _width: number, _dark: boolean) => true) };
    const load = () => native;
    const config = { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 0,
      sidebarMaterial: 'light' as const };
    setMacSidebarWidth(win, 260, load);
    expect(native.setSidebar).not.toHaveBeenCalled(); // theme snapshot not ready
    applyMacWindowBackdrop(win, config, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 260, false);
    first.webContents.getZoomFactor.mockReturnValue(1.25);
    setMacSidebarWidth(win, 300, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 375, false);
    const count = native.setSidebar.mock.calls.length;
    for (const bad of [-1, Infinity, NaN, '260', 16385]) setMacSidebarWidth(win, bad, load);
    expect(native.setSidebar).toHaveBeenCalledTimes(count);
    applyMacWindowBackdrop(second as unknown as BrowserWindow, config, load);
    expect(native.setSidebar).toHaveBeenCalledTimes(count);
    setMacSidebarWidth(win, 0, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 0, false);
    setMacSidebarWidth(win, 260, load);
    applyMacWindowBackdrop(win, { ...config, desktopBlurRadius: 20, sidebarMaterial: 'dark' }, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 325, true);
    applyMacWindowBackdrop(win, { vibrancy: null, backgroundColor: '#ffffff' }, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 0, false);
    applyMacWindowBackdrop(win, config, load);
    expect(native.setSidebar).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 325, false);
  });
});
