import { describe, expect, it, vi } from 'vitest';

import { createPiRuntimeRecovery } from '../pi-runtime-recovery.js';

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
      () => new Promise<{ ready: boolean; path?: string; error?: string }>((resolve) => {
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
    const first = recovery.retryNow();
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
});
