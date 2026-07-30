import { describe, expect, it, vi } from 'vitest';

import {
  MACOS_UPDATE_RELAUNCH_ARG,
  createUpdatePresentationRecoveryController,
  decideUpdateRelaunchBusyTransition,
  decideUpdatePresentationRecovery,
  hasUpdateRelaunchBusyActivity,
  isMacOSUpdateRelaunch,
  readUpdateRelaunchScheduleBusy,
  type UpdateSystemIdleState,
} from '../updateRelaunchSafety';

function createRecoveryHarness(
  options: {
    locked?: boolean;
    screenState?: 'active' | 'idle' | 'locked' | 'unknown';
    windowExists?: boolean;
    windowFocused?: boolean;
    focusSucceeds?: boolean;
    maxFocusAttempts?: number;
  } = {},
) {
  const state: {
    screenState: UpdateSystemIdleState;
    windowExists: boolean;
    windowFocused: boolean;
  } = {
    screenState: options.screenState ?? (options.locked ? 'locked' : 'active'),
    windowExists: options.windowExists ?? true,
    windowFocused: options.windowFocused ?? false,
  };
  let nextHandle = 1;
  let focusCount = 0;
  const scheduled = new Map<number, () => void>();
  const events: string[] = [];
  const controller = createUpdatePresentationRecoveryController({
    readScreenState: () => state.screenState,
    readWindowState: () => ({
      exists: state.windowExists,
      focused: state.windowFocused,
    }),
    focusWindow: () => {
      focusCount += 1;
      if (options.focusSucceeds !== false) state.windowFocused = true;
    },
    schedule: (callback) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      scheduled.delete(handle as number);
    },
    onEvent: (event) => events.push(event),
    maxFocusAttempts: options.maxFocusAttempts,
  });

  return {
    controller,
    state,
    events,
    focusCount: () => focusCount,
    scheduledCount: () => scheduled.size,
    runScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe('update relaunch marker', () => {
  it('recognizes only the exact update relaunch marker', () => {
    expect(isMacOSUpdateRelaunch([MACOS_UPDATE_RELAUNCH_ARG])).toBe(true);
    expect(isMacOSUpdateRelaunch([`${MACOS_UPDATE_RELAUNCH_ARG}=1`])).toBe(false);
    expect(isMacOSUpdateRelaunch([])).toBe(false);
  });
});

describe('update relaunch busy probe', () => {
  it.each([
    { previousBusy: false, nextBusy: false, shouldNotify: false },
    { previousBusy: false, nextBusy: true, shouldNotify: true },
    { previousBusy: true, nextBusy: true, shouldNotify: false },
    { previousBusy: true, nextBusy: false, shouldNotify: true },
  ])(
    'notifies only on remote busy edges ($previousBusy → $nextBusy)',
    ({ previousBusy, nextBusy, shouldNotify }) => {
      expect(decideUpdateRelaunchBusyTransition(previousBusy, nextBusy)).toEqual({
        nextBusy,
        shouldNotify,
      });
    },
  );

  it('treats uninitialized scheduler storage as an idle cold-start state', async () => {
    await expect(readUpdateRelaunchScheduleBusy(null)).resolves.toBe(false);
  });

  it('reports running schedules after storage is initialized', async () => {
    await expect(readUpdateRelaunchScheduleBusy({
      hasRunningRuns: async () => true,
    })).resolves.toBe(true);
  });

  it('propagates initialized storage query failures to the fail-closed guard', async () => {
    await expect(readUpdateRelaunchScheduleBusy({
      hasRunningRuns: async () => {
        throw new Error('db unavailable');
      },
    })).rejects.toThrow('db unavailable');
  });

  it('re-samples synchronous activity after the async schedule query', async () => {
    let synchronousBusy = false;
    let finishScheduleRead: ((value: boolean) => void) | undefined;
    const scheduleRead = new Promise<boolean>((resolve) => {
      finishScheduleRead = resolve;
    });
    const readSynchronousBusy = vi.fn(() => synchronousBusy);

    const result = hasUpdateRelaunchBusyActivity({
      readSynchronousBusy,
      readScheduleBusy: () => scheduleRead,
    });
    synchronousBusy = true;
    finishScheduleRead?.(false);

    await expect(result).resolves.toBe(true);
    expect(readSynchronousBusy).toHaveBeenCalledTimes(2);
  });

  it('fails closed when schedule activity cannot be read', async () => {
    await expect(hasUpdateRelaunchBusyActivity({
      readSynchronousBusy: () => false,
      readScheduleBusy: async () => {
        throw new Error('db unavailable');
      },
    })).resolves.toBe(true);
  });
});

describe('update presentation recovery', () => {
  it('keeps recovery pending while the screen is locked', () => {
    expect(
      decideUpdatePresentationRecovery({
        pending: true,
        screenLocked: true,
        windowExists: true,
        windowFocused: false,
      }),
    ).toEqual({ nextPending: true, focusOnce: false });
  });

  it('focuses an update-launched window once after unlock', () => {
    expect(
      decideUpdatePresentationRecovery({
        pending: true,
        screenLocked: false,
        windowExists: true,
        windowFocused: false,
      }),
    ).toEqual({ nextPending: true, focusOnce: true });
  });

  it('consumes recovery without stealing focus when the window is already focused', () => {
    expect(
      decideUpdatePresentationRecovery({
        pending: true,
        screenLocked: false,
        windowExists: true,
        windowFocused: true,
      }),
    ).toEqual({ nextPending: false, focusOnce: false });
  });

  it('does nothing without a pending update or a surviving window', () => {
    expect(
      decideUpdatePresentationRecovery({
        pending: false,
        screenLocked: false,
        windowExists: true,
        windowFocused: false,
      }),
    ).toEqual({ nextPending: false, focusOnce: false });
    expect(
      decideUpdatePresentationRecovery({
        pending: true,
        screenLocked: false,
        windowExists: false,
        windowFocused: false,
      }),
    ).toEqual({ nextPending: false, focusOnce: false });
  });
});

describe('update presentation recovery controller', () => {
  it('waits through lock and focuses exactly once after unlock', () => {
    const harness = createRecoveryHarness({ locked: true });
    harness.controller.arm();
    harness.controller.onWindowReady();
    harness.runScheduled();

    expect(harness.focusCount()).toBe(0);
    expect(harness.events).toEqual(['deferred-locked']);

    harness.state.screenState = 'active';
    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
    expect(harness.events).toEqual(['deferred-locked', 'focus-window']);

    harness.controller.onScreenLock();
    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
  });

  it('cancels an early settle if the screen locks before the timer fires', () => {
    const harness = createRecoveryHarness();
    harness.controller.arm();
    harness.controller.onWindowReady();
    expect(harness.scheduledCount()).toBe(1);

    harness.controller.onScreenLock();
    expect(harness.scheduledCount()).toBe(0);
    harness.runScheduled();
    expect(harness.focusCount()).toBe(0);

    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
  });

  it('consumes recovery when show focuses before ready, even if the user then switches away', () => {
    const harness = createRecoveryHarness();
    harness.controller.arm();
    harness.controller.onWindowFocused();
    harness.state.windowFocused = false;
    harness.controller.onWindowReady();
    harness.runScheduled();

    expect(harness.scheduledCount()).toBe(0);
    expect(harness.focusCount()).toBe(0);
  });

  it('does not schedule unlock recovery before ready-to-show', () => {
    const harness = createRecoveryHarness({ locked: true });
    harness.controller.arm();
    harness.state.screenState = 'active';
    harness.controller.onScreenUnlock();
    expect(harness.scheduledCount()).toBe(0);

    harness.controller.onWindowReady();
    expect(harness.scheduledCount()).toBe(1);
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
  });

  it('pauses unknown-state polling but retains recovery for a later explicit unlock', () => {
    const harness = createRecoveryHarness({ screenState: 'unknown' });
    harness.controller.arm();
    harness.controller.onWindowReady();
    harness.runScheduled();
    expect(harness.scheduledCount()).toBe(1);
    harness.runScheduled();

    expect(harness.events).toContain('paused-unknown');
    harness.state.screenState = 'active';
    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
  });

  it('does not let an unknown probe erase explicit lock and unlock events', () => {
    const harness = createRecoveryHarness({ locked: true });
    harness.controller.arm();
    harness.controller.onScreenLock();
    harness.state.screenState = 'unknown';
    harness.controller.onWindowReady();

    expect(harness.scheduledCount()).toBe(0);
    expect(harness.events).toEqual(['deferred-locked']);

    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(1);
  });

  it('retries a denied focus only up to the configured bound', () => {
    const harness = createRecoveryHarness({ focusSucceeds: false, maxFocusAttempts: 3 });
    harness.controller.arm();
    harness.controller.onWindowReady();

    harness.runScheduled();
    harness.runScheduled();
    harness.runScheduled();

    expect(harness.focusCount()).toBe(3);
    expect(harness.events).toEqual([
      'focus-window',
      'focus-window',
      'focus-window',
      'abandoned-unfocused',
    ]);
    harness.controller.onScreenUnlock();
    harness.runScheduled();
    expect(harness.focusCount()).toBe(3);
  });

  it('does not focus when already focused, not armed, or the window is gone', () => {
    const focused = createRecoveryHarness({ windowFocused: true });
    focused.controller.arm();
    focused.controller.onWindowReady();
    focused.runScheduled();
    expect(focused.focusCount()).toBe(0);

    const notArmed = createRecoveryHarness();
    notArmed.controller.onWindowReady();
    notArmed.runScheduled();
    expect(notArmed.focusCount()).toBe(0);

    const destroyed = createRecoveryHarness();
    destroyed.controller.arm();
    destroyed.controller.onWindowReady();
    destroyed.state.windowExists = false;
    destroyed.runScheduled();
    destroyed.controller.onScreenUnlock();
    destroyed.runScheduled();
    expect(destroyed.focusCount()).toBe(0);
  });
});
