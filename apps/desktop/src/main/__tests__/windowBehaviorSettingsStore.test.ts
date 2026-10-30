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

  it('asks for a Linux close behavior until the user chooses one', () => {
    expect(__testing.normalize(undefined).linuxCloseBehavior).toBeNull();
    expect(__testing.normalize({}).linuxCloseBehavior).toBeNull();
  });

  it.each(['tray', 'quit'] as const)('accepts the %s Windows close behavior', (behavior) => {
    expect(__testing.normalize({ windowsCloseBehavior: behavior }).windowsCloseBehavior).toBe(
      behavior,
    );
  });

  it.each(['minimize', 'quit'] as const)('accepts the %s Linux close behavior', (behavior) => {
    expect(__testing.normalize({ linuxCloseBehavior: behavior }).linuxCloseBehavior).toBe(behavior);
  });

  it('rejects invalid persisted close behaviors', () => {
    expect(__testing.normalize({ windowsCloseBehavior: 'hide' }).windowsCloseBehavior).toBeNull();
    expect(__testing.normalize({ linuxCloseBehavior: 'tray' }).linuxCloseBehavior).toBeNull();
  });
});
