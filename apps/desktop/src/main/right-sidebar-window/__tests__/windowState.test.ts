import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manage: vi.fn(),
  windowStateKeeper: vi.fn(),
}));

vi.mock('electron-window-state', () => ({ default: mocks.windowStateKeeper }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../windowFocusClassifier.js', () => ({ markAppContentWindow: vi.fn() }));
vi.mock('../../window-behavior-settings-store.js', () => ({
  readWindowBehaviorSettings: () => ({ swallowActivationClick: true }),
}));
vi.mock('../../secondary-windows.js', () => ({ installExternalLinkGuards: vi.fn() }));
vi.mock('../../selection-context-menu.js', () => ({ installSelectionContextMenu: vi.fn() }));
vi.mock('../../appearance-settings-ipc.js', () => ({ applyAppearanceToWindow: vi.fn() }));
vi.mock('../registry.js', () => ({ markRsbWindowWebContentsId: vi.fn() }));

import { createRightSidebarWindow } from '../window';

describe('createRightSidebarWindow window state', () => {
  beforeEach(() => {
    mocks.windowStateKeeper.mockReturnValue({
      x: 100,
      y: 120,
      width: 520,
      height: 860,
      manage: mocks.manage,
    });
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores geometry without restoring modes that can reveal the hidden prewarm window', () => {
    const win = createRightSidebarWindow();

    expect(mocks.windowStateKeeper).toHaveBeenCalledWith({
      defaultWidth: 520,
      defaultHeight: 860,
      file: 'right-sidebar-window-state.json',
      maximize: false,
      fullScreen: false,
    });
    expect(mocks.manage).toHaveBeenCalledWith(win);
  });
});
