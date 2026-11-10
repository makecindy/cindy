import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applyMacWindowBackdrop } from '../macosDesktopBlur';

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
  };
};
describe('Mac desktop blur application', () => {
  // Performance contract: identical updates must not touch native state, and
  // radius-only changes must not recreate the material or rounded-window backing.
  it('updates only changed native properties', () => {
    const first = windowFixture();
    const win = first as unknown as BrowserWindow;
    const native = { apply: vi.fn(() => true) };
    const load = () => native;
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 5 };
    applyMacWindowBackdrop(win, config, load);
    for (let i = 0; i < 100; i++) applyMacWindowBackdrop(win, { ...config }, load);
    expect(native.apply).toHaveBeenCalledTimes(1);
    expect(first.setBackgroundColor).toHaveBeenCalledTimes(1);
    const materialCalls = first.setVibrancy.mock.calls.length;
    applyMacWindowBackdrop(win, { ...config, desktopBlurRadius: 20 }, load);
    expect(native.apply).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 20);
    expect(first.setVibrancy).toHaveBeenCalledTimes(materialCalls);
  });

  it('passes distinct radii and clears only the affected window when artwork covers it', () => {
    const first = windowFixture(), second = windowFixture();
    const native = { apply: vi.fn<(handle: Buffer, radius: number) => boolean>(() => true) };
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

  // The sidebar shares the window-wide radius: no fixed system material may stay
  // under it in desktop mode, including radius zero, and the theme material
  // returns in full when the desktop backdrop is left.
  it('uses only the adjustable radius in desktop mode and restores the theme material after it', () => {
    const first = windowFixture();
    const win = first as unknown as BrowserWindow;
    const native = { apply: vi.fn<(handle: Buffer, radius: number) => boolean>(() => true) };
    applyMacWindowBackdrop(win, { vibrancy: 'hud', backgroundColor: '#00000000' }, () => native);
    expect(first.setVibrancy.mock.lastCall).toEqual(['hud']);
    applyMacWindowBackdrop(win, { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 0 }, () => native);
    expect(first.setVibrancy.mock.lastCall).toEqual([null]);
    expect(native.apply).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 0);
    applyMacWindowBackdrop(win, { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 12 }, () => native);
    expect(first.setVibrancy.mock.lastCall).toEqual([null]);
    applyMacWindowBackdrop(win, { vibrancy: 'hud', backgroundColor: '#00000000' }, () => native);
    expect(native.apply).toHaveBeenLastCalledWith(first.getNativeWindowHandle(), 0);
    expect(first.setVibrancy.mock.lastCall).toEqual(['hud']);
  });

  it('retains system material if the native module rejects the radius and ignores destroyed windows', () => {
    const win = windowFixture();
    const native = { apply: vi.fn<(handle: Buffer, radius: number) => boolean>(() => false) };
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

  it('keeps the system material fallback when the native addon is unavailable', () => {
    const win = windowFixture();
    const config = { vibrancy: 'under-window', backgroundColor: '#00000000', desktopBlurRadius: 5 };
    applyMacWindowBackdrop(win as unknown as BrowserWindow, config, () => null);
    expect(win.setVibrancy.mock.lastCall).toEqual(['under-window']);
  });
});
