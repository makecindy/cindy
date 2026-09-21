import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock('../appearance-settings-store.js', () => ({
  readAppearanceSettings: () => ({ windowZoom: 1 }),
  readAppearanceSettingsState: vi.fn(), writeAppearanceSettingsPatch: vi.fn(),
  resetAppearanceSettings: vi.fn(), updateAppearanceSettingsAtomic: vi.fn(),
}));

import { applyAppearanceToWindow } from '../appearance-settings-ipc.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';

function windowFixture(currentZoom: number, marked = true) {
  const setZoomFactor = vi.fn();
  const win = { isDestroyed: () => false, webContents: {
    id: 1, isDestroyed: () => false, getZoomFactor: () => currentZoom, setZoomFactor,
  } } as unknown as BrowserWindow;
  if (marked) markAppContentWindow(win);
  return { win, setZoomFactor };
}

describe('persisted zoom application', () => {
  it('does not reapply identical zoom or floating point noise', () => {
    for (const factor of [1.1, 1.1005]) {
      const { win, setZoomFactor } = windowFixture(factor);
      applyAppearanceToWindow(win, { windowZoom: 1.1 });
      expect(setZoomFactor).not.toHaveBeenCalled();
    }
  });

  it('restores a genuinely different zoom factor', () => {
    const { win, setZoomFactor } = windowFixture(1);
    applyAppearanceToWindow(win, { windowZoom: 1.2 }, 'test');
    expect(setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.2);
  });

  it('never changes unregistered or destroyed windows', () => {
    const unregistered = windowFixture(1, false);
    applyAppearanceToWindow(unregistered.win, { windowZoom: 1.2 });
    expect(unregistered.setZoomFactor).not.toHaveBeenCalled();
    const destroyed = windowFixture(1);
    destroyed.win.webContents.isDestroyed = () => true;
    applyAppearanceToWindow(destroyed.win, { windowZoom: 1.2 });
    expect(destroyed.setZoomFactor).not.toHaveBeenCalled();
  });
});
