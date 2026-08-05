import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  trustedTopLevel: vi.fn(),
  trustedWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  isTrustedCindyRendererWindow: mocks.trustedWindow,
  isTrustedTopLevelCindyRendererEvent: mocks.trustedTopLevel,
}));

import {
  isTrustedAppearanceSettingsReadEvent,
  isTrustedAppearanceSettingsReadWindow,
  markAppearanceSettingsReaderWindow,
} from '../appearance-settings-reader.js';
import { isAppContentWindow, markAppContentWindow } from '../windowFocusClassifier.js';

function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed } as never;
}

describe('appearance settings reader authorization', () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReset();
    mocks.trustedTopLevel.mockReset().mockReturnValue(true);
    mocks.trustedWindow.mockReset().mockReturnValue(true);
  });

  it('允许 app-content 窗口读取启动快照', () => {
    const win = fakeWindow();
    markAppContentWindow(win);
    mocks.fromWebContents.mockReturnValue(win);

    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(true);
  });

  it('只允许显式登记的 utility 窗口读取，且不提升为 app-content', () => {
    const registered = fakeWindow();
    markAppearanceSettingsReaderWindow(registered);
    mocks.fromWebContents.mockReturnValue(registered);

    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(true);
    expect(isAppContentWindow(registered)).toBe(false);
    expect(isTrustedAppearanceSettingsReadWindow(registered)).toBe(true);

    mocks.fromWebContents.mockReturnValue(fakeWindow());
    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(false);
  });

  it('拒绝非可信页面、无法归属窗口和已销毁窗口', () => {
    const destroyed = fakeWindow(true);
    markAppearanceSettingsReaderWindow(destroyed);
    mocks.fromWebContents.mockReturnValue(destroyed);
    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(false);

    mocks.fromWebContents.mockReturnValue(null);
    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(false);

    mocks.trustedTopLevel.mockReturnValue(false);
    const registered = fakeWindow();
    markAppearanceSettingsReaderWindow(registered);
    mocks.fromWebContents.mockReturnValue(registered);
    expect(isTrustedAppearanceSettingsReadEvent({ sender: {} } as never)).toBe(false);

    mocks.trustedTopLevel.mockReturnValue(true);
    mocks.trustedWindow.mockReturnValue(false);
    expect(isTrustedAppearanceSettingsReadWindow(registered)).toBe(false);
  });
});
