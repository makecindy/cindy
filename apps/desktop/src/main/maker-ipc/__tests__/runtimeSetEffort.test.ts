import { describe, expect, it, vi } from 'vitest';

import {
  applyRuntimeEffortWithRecovery,
  RuntimeControlTimeoutError,
} from '../runtimeSetEffort.js';

describe('applyRuntimeEffortWithRecovery', () => {
  it('keeps a session whose runtime control succeeds', async () => {
    const terminateSession = vi.fn(async () => undefined);

    await expect(
      applyRuntimeEffortWithRecovery({
        applyRuntime: async () => undefined,
        terminateSession,
      }),
    ).resolves.toBe('applied');
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('propagates an immediate runtime rejection without terminating the session', async () => {
    const terminateSession = vi.fn(async () => undefined);

    await expect(
      applyRuntimeEffortWithRecovery({
        applyRuntime: async () => {
          throw new Error('runtime rejected');
        },
        terminateSession,
      }),
    ).rejects.toThrow('runtime rejected');
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('terminates a session whose runtime control never settles', async () => {
    vi.useFakeTimers();
    try {
      const terminateSession = vi.fn(async () => undefined);
      const result = applyRuntimeEffortWithRecovery({
        applyRuntime: () => new Promise<void>(() => undefined),
        terminateSession,
        runtimeTimeoutMs: 25,
        terminationTimeoutMs: 10,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe('session-terminated');
      expect(terminateSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stuck recovery termination', async () => {
    vi.useFakeTimers();
    try {
      const result = applyRuntimeEffortWithRecovery({
        applyRuntime: () => new Promise<void>(() => undefined),
        terminateSession: () => new Promise<void>(() => undefined),
        runtimeTimeoutMs: 25,
        terminationTimeoutMs: 10,
      });
      const rejection = expect(result).rejects.toBeInstanceOf(RuntimeControlTimeoutError);

      await vi.advanceTimersByTimeAsync(35);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
