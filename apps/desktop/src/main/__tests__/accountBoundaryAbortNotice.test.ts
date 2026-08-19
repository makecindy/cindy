import { describe, expect, it, vi } from 'vitest';

import {
  showAccountBoundaryAbortNotice,
  type AccountBoundaryAbortNoticeDeps,
} from '../accountBoundaryAbortNotice';

function deps(overrides: Partial<AccountBoundaryAbortNoticeDeps> = {}): {
  deps: AccountBoundaryAbortNoticeDeps;
  showDialog: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const showDialog = vi.fn(async () => ({ response: 1 }));
  const relaunch = vi.fn();
  const quit = vi.fn();
  const logError = vi.fn();
  return {
    showDialog,
    relaunch,
    quit,
    logError,
    deps: {
      strings: {
        title: 'title',
        message: 'message',
        detail: 'detail',
        restartNow: 'restart',
        later: 'later',
      },
      showDialog: showDialog as unknown as AccountBoundaryAbortNoticeDeps['showDialog'],
      relaunch,
      quit,
      logError,
      ...overrides,
    },
  };
}

describe('showAccountBoundaryAbortNotice', () => {
  it('offers a restart, defaulting to the choice that changes nothing', async () => {
    const h = deps();

    await showAccountBoundaryAbortNotice(h.deps);

    expect(h.showDialog).toHaveBeenCalledTimes(1);
    const options = h.showDialog.mock.calls[0]![0] as {
      buttons: string[]; defaultId: number; cancelId: number; type: string;
    };
    expect(options.buttons).toEqual(['restart', 'later']);
    // Nothing is lost by postponing, and a restart nobody asked for could
    // interrupt work in progress.
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(options.type).toBe('warning');
  });

  it('relaunches through quit when the user asks to restart now', async () => {
    // `quit`, not a hard exit: no updater process is waiting to take over, so
    // the before-quit chain still has to stop the agents and flush local state.
    const h = deps({ showDialog: (async () => ({ response: 0 })) as never });

    await showAccountBoundaryAbortNotice(h.deps);

    expect(h.relaunch).toHaveBeenCalledTimes(1);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('does nothing but close when the user postpones', async () => {
    const h = deps();

    await showAccountBoundaryAbortNotice(h.deps);

    expect(h.relaunch).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('never lets a dialog it cannot show become a second failure', async () => {
    // No window yet, or a headless run. The abort path is already unwinding;
    // this must not add an unhandled rejection to it.
    const h = deps({
      showDialog: (() => Promise.reject(new Error('no window'))) as never,
    });

    await expect(showAccountBoundaryAbortNotice(h.deps)).resolves.toBeUndefined();

    expect(h.logError).toHaveBeenCalled();
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });
});
