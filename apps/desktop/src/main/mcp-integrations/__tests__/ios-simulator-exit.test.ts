import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abortIOSSimulatorOperationsForExit,
  registerIOSSimulatorExitAbortHandler,
} from '../ios-simulator-exit';

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('iOS Simulator updater exit abort seam', () => {
  it('calls the registered lightweight abort handler', () => {
    const abort = vi.fn();
    unregister = registerIOSSimulatorExitAbortHandler(abort);

    abortIOSSimulatorOperationsForExit();

    expect(abort).toHaveBeenCalledOnce();
  });

  it('does not let stale unregister callbacks remove a replacement handler', () => {
    const first = vi.fn();
    const unregisterFirst = registerIOSSimulatorExitAbortHandler(first);
    const second = vi.fn();
    unregister = registerIOSSimulatorExitAbortHandler(second);

    unregisterFirst();
    abortIOSSimulatorOperationsForExit();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('does not let a cleanup failure block the updater exit seam', () => {
    unregister = registerIOSSimulatorExitAbortHandler(() => {
      throw new Error('already exited');
    });

    expect(() => abortIOSSimulatorOperationsForExit()).not.toThrow();
  });
});
