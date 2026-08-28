import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import { __testing } from '../window-behavior-settings-store';

describe('window behavior settings store', () => {
  it('asks for a Windows close behavior until the user chooses one', () => {
    expect(__testing.normalize(undefined).windowsCloseBehavior).toBeNull();
    expect(__testing.normalize({}).windowsCloseBehavior).toBeNull();
  });

  it.each(['tray', 'quit'] as const)('accepts the %s Windows close behavior', (behavior) => {
    expect(__testing.normalize({ windowsCloseBehavior: behavior }).windowsCloseBehavior).toBe(
      behavior,
    );
  });

  it('rejects invalid persisted close behavior', () => {
    expect(__testing.normalize({ windowsCloseBehavior: 'hide' }).windowsCloseBehavior).toBeNull();
  });

  it('shows the window on login start until the user opts in', () => {
    expect(__testing.normalize(undefined).startInTrayOnLogin).toBe(false);
    expect(__testing.normalize({}).startInTrayOnLogin).toBe(false);
  });

  it('keeps the persisted start-in-tray choice', () => {
    expect(__testing.normalize({ startInTrayOnLogin: true }).startInTrayOnLogin).toBe(true);
    expect(__testing.normalize({ startInTrayOnLogin: false }).startInTrayOnLogin).toBe(false);
  });

  it('falls back to showing the window for a non-boolean start-in-tray value', () => {
    expect(__testing.normalize({ startInTrayOnLogin: 'yes' }).startInTrayOnLogin).toBe(false);
  });

  // 两个开关互不影响:关掉自启动不该清除用户对托盘启动的选择。
  it('keeps start-in-tray independent from the close behavior', () => {
    const settings = __testing.normalize({
      windowsCloseBehavior: 'quit',
      startInTrayOnLogin: true,
    });
    expect(settings.windowsCloseBehavior).toBe('quit');
    expect(settings.startInTrayOnLogin).toBe(true);
  });
});
