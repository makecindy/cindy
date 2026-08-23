import { describe, expect, it } from 'vitest';

import type { WorkLouderCodexRendererAction } from '../../../shared/workLouderCodex.js';
import {
  createWorkLouderCodexActiveWindowRouter,
  workLouderCodexActionWindowTarget,
} from '../actionWindow.js';

function fakeWindow(id: string, options?: { destroyed?: boolean; loading?: boolean }) {
  return {
    id,
    isDestroyed: () => options?.destroyed === true,
    webContents: {
      isDestroyed: () => options?.destroyed === true,
      isLoading: () => options?.loading === true,
    },
  };
}

describe('workLouderCodexActionWindowTarget', () => {
  it('keeps encoder task switching on the primary window', () => {
    expect(
      workLouderCodexActionWindowTarget({
        type: 'command',
        commandId: 'session.selectNext',
      }),
    ).toBe('task-switch');
    expect(
      workLouderCodexActionWindowTarget({
        type: 'command',
        commandId: 'session.selectPrevious',
      }),
    ).toBe('task-switch');
  });

  it('sends voice, send, and scroll to the system frontmost app when Cindy is not focused', () => {
    expect(workLouderCodexActionWindowTarget({ type: 'voice', phase: 'press' })).toBe(
      'system-frontmost',
    );
    expect(
      workLouderCodexActionWindowTarget({ type: 'command', commandId: 'composer.submit' }),
    ).toBe('system-frontmost');
    expect(
      workLouderCodexActionWindowTarget({
        type: 'scroll',
        direction: 'up',
        intensity: 1,
      }),
    ).toBe('system-frontmost');
  });
});

describe('createWorkLouderCodexActiveWindowRouter', () => {
  it('routes send to the focused secondary window and task switching to main', () => {
    const main = fakeWindow('main');
    const secondary = fakeWindow('secondary');
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => secondary,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main' || win?.id === 'secondary',
    });

    expect(router.resolve({ type: 'command', commandId: 'composer.submit' })).toBe(secondary);
    expect(router.resolve({ type: 'command', commandId: 'session.selectNext' })).toBe(main);
  });

  it('does not steal send from a utility window back to the main Cindy window', () => {
    const main = fakeWindow('main');
    const utility = fakeWindow('utility');
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => utility,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main',
    });

    expect(router.resolve({ type: 'command', commandId: 'composer.submit' })).toBeNull();
  });

  it('leaves voice, send, and scroll on the system frontmost app when Cindy is not focused', () => {
    const main = fakeWindow('main');
    const utility = fakeWindow('utility');
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => utility,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main',
    });

    expect(router.resolve({ type: 'voice', phase: 'press' })).toBeNull();
    expect(router.resolve({ type: 'command', commandId: 'composer.submit' })).toBeNull();
    expect(
      router.resolve({ type: 'scroll', direction: 'down', intensity: 0.8 }),
    ).toBeNull();
  });

  it('keeps a voice release on the window that received the press', () => {
    const main = fakeWindow('main');
    const secondary = fakeWindow('secondary');
    let focused = secondary;
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => focused,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main' || win?.id === 'secondary',
    });

    expect(router.resolve({ type: 'voice', phase: 'press' })).toBe(secondary);
    focused = main;
    expect(router.resolve({ type: 'voice', phase: 'release' })).toBe(secondary);
    expect(router.resolve({ type: 'command', commandId: 'composer.submit' })).toBe(main);
  });

  it('keeps joystick scroll on the window that started the push', () => {
    const main = fakeWindow('main');
    const secondary = fakeWindow('secondary');
    let focused = secondary;
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => focused,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main' || win?.id === 'secondary',
    });
    const scroll: WorkLouderCodexRendererAction = {
      type: 'scroll',
      direction: 'down',
      intensity: 0.8,
    };

    expect(router.resolve(scroll)).toBe(secondary);
    focused = main;
    expect(router.resolve(scroll)).toBe(secondary);
    expect(router.resolve({ type: 'scroll-stop' })).toBe(secondary);
    expect(router.resolve({ type: 'command', commandId: 'composer.submit' })).toBe(main);
  });

  it('does not let a scroll-stop steal the in-flight voice window', () => {
    const main = fakeWindow('main');
    const secondary = fakeWindow('secondary');
    let focused = secondary;
    const router = createWorkLouderCodexActiveWindowRouter({
      getFocusedWindow: () => focused,
      getMainWindow: () => main,
      isActionWindow: (win) => win?.id === 'main' || win?.id === 'secondary',
    });

    expect(router.resolve({ type: 'voice', phase: 'press' })).toBe(secondary);
    expect(
      router.resolve({ type: 'scroll', direction: 'down', intensity: 0.8 }),
    ).toBe(secondary);
    focused = main;
    expect(router.resolve({ type: 'scroll-stop' })).toBe(secondary);
    expect(router.resolve({ type: 'voice', phase: 'release' })).toBe(secondary);
  });
});
