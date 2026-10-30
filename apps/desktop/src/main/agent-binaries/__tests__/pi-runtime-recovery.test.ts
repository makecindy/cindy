import { describe, expect, it, vi } from 'vitest';

import {
  createPiRuntimeRecovery,
  PI_RUNTIME_RECOVERY_RETRY_DELAYS_MS,
} from '../pi-runtime-recovery.js';

describe('Pi runtime recovery', () => {
  it('retries after the network returns and registers Pi once', async () => {
    let online = false;
    let prepareCalls = 0;
    let registered = false;
    const onRegistered = vi.fn();
    const recovery = createPiRuntimeRecovery({
      isOnline: () => online,
      prepare: async () => {
        prepareCalls += 1;
        return { ready: true, path: '/tmp/pi' };
      },
      register: () => {
        if (registered) return false;
        registered = true;
        return true;
      },
      onRegistered,
      retryDelayMs: 60_000,
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    expect(await recovery.retryNow('offline')).toBe(false);
    online = true;
    expect(await recovery.retryNow('online')).toBe(true);
    expect(await recovery.retryNow('duplicate')).toBe(false);
    expect(prepareCalls).toBe(1);
    expect(onRegistered).toHaveBeenCalledOnce();
    expect(recovery.isDisabled()).toBe(false);
    recovery.dispose();
  });

  it('deduplicates concurrent recovery and keeps retryable failure disabled', async () => {
    let resolvePrepare!: (value: { ready: boolean; path?: string; error?: string }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{ ready: boolean; path?: string; error?: string }>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      retryDelayMs: 60_000,
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    const focusStart = performance.now();
    const first = recovery.retryNow('window-focus');
    expect(performance.now() - focusStart).toBeLessThan(100);
    const second = recovery.retryNow();
    expect(first).toBe(second);
    expect(prepare).toHaveBeenCalledOnce();
    resolvePrepare({ ready: false, error: 'still_offline' });
    expect(await first).toBe(false);
    expect(recovery.isDisabled()).toBe(true);
    recovery.dispose();
  });

  it('does not schedule retries for permanent prepare errors', async () => {
    const prepare = vi.fn(async () => ({ ready: true, path: '/tmp/pi' }));
    const schedule = vi.fn(() => 0);
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('asset_missing');
    expect(schedule).not.toHaveBeenCalled();
    expect(await recovery.retryNow('permanent')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    recovery.dispose();
  });

  it('stops an existing retry loop when a later prepare becomes permanent', async () => {
    const prepare = vi.fn(async () => ({ ready: false, error: 'asset_missing' }));
    const schedule = vi.fn(() => 0);
    const cancel = vi.fn();
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
      setTimeout: schedule as unknown as typeof setTimeout,
      clearTimeout: cancel as unknown as typeof clearTimeout,
    });

    recovery.markUnavailable('manifest_failed');
    expect(schedule).toHaveBeenCalledOnce();
    expect(await recovery.retryNow('permanent-after-transient')).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledOnce();
    expect(recovery.isDisabled()).toBe(true);
    recovery.dispose();
  });

  it('backs off consecutive timer failures, while immediate triggers keep the current step', async () => {
    vi.useFakeTimers();
    let ready = false;
    const prepare = vi.fn(async () =>
      ready ? { ready: true, path: '/tmp/pi' } : { ready: false, error: 'manifest_failed' },
    );
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register: () => true,
      onRegistered: vi.fn(),
    });

    try {
      recovery.markUnavailable('manifest_failed');
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(prepare).toHaveBeenCalledTimes(1);
      const focused = recovery.retryNow('window-focus');
      expect(prepare).toHaveBeenCalledTimes(2);
      await expect(focused).resolves.toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.advanceTimersByTimeAsync(300_000);

      expect(prepare).toHaveBeenCalledTimes(6);
      expect(PI_RUNTIME_RECOVERY_RETRY_DELAYS_MS).toEqual([30_000, 60_000, 120_000, 300_000]);

      ready = true;
      await vi.advanceTimersByTimeAsync(299_999);
      expect(prepare).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(prepare).toHaveBeenCalledTimes(7);
      expect(vi.getTimerCount()).toBe(0);

      ready = false;
      recovery.markUnavailable('manifest_failed');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(prepare).toHaveBeenCalledTimes(8);
    } finally {
      recovery.dispose();
      vi.useRealTimers();
    }
  });

  it('shares an in-flight timer attempt and does not register after disposal', async () => {
    let resolvePrepare!: (value: { ready: boolean; path: string }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{ ready: boolean; path: string }>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const register = vi.fn(() => true);
    const recovery = createPiRuntimeRecovery({
      isOnline: () => true,
      prepare,
      register,
      onRegistered: vi.fn(),
      retryDelayMs: 1,
    });

    recovery.markUnavailable('manifest_failed');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const focused = recovery.retryNow('window-focus');
    recovery.dispose();
    resolvePrepare({ ready: true, path: '/tmp/pi' });

    await expect(focused).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});
