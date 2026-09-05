import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CREDENTIAL_RECOVERY_ARG,
  createAuthCredentialRecovery,
  type AuthCredentialRecoveryDeps,
} from '../authCredentialRecovery';

function setup(overrides: Partial<AuthCredentialRecoveryDeps> = {}) {
  const deps: AuthCredentialRecoveryDeps = {
    enabled: true,
    argv: ['--profile=test', '--xdt-update-relaunch'],
    needsRecovery: vi.fn(() => true),
    readScreenState: vi.fn(() => 'active' as const),
    isQuitting: vi.fn(() => false),
    isBusy: vi.fn(async () => false),
    relaunch: vi.fn(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onEvent: vi.fn(),
    ...overrides,
  };
  return { deps, controller: createAuthCredentialRecovery(deps) };
}

describe('credential failure process recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for unlock and a settle delay, then restarts once with the same profile', async () => {
    let state: 'locked' | 'active' = 'locked';
    const { deps, controller } = setup({ readScreenState: () => state });
    controller.request();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deps.relaunch).not.toHaveBeenCalled();
    state = 'active';
    controller.onScreenUnlock();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(deps.relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.relaunch).toHaveBeenCalledWith([
      '--profile=test',
      '--xdt-update-relaunch',
      AUTH_CREDENTIAL_RECOVERY_ARG,
    ]);
    controller.request();
    controller.onScreenUnlock();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('does not loop if the successor also cannot read the keychain', async () => {
    const { deps, controller } = setup({ argv: [AUTH_CREDENTIAL_RECOVERY_ARG] });
    controller.request();
    controller.onScreenUnlock();
    controller.request();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(deps.isBusy).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(deps.onEvent).toHaveBeenCalledExactlyOnceWith('attempt-exhausted');
  });

  it.each(['disabled', 'healthy', 'quitting'] as const)(
    'does nothing when %s',
    async (condition) => {
      const { deps, controller } = setup({
        enabled: condition !== 'disabled',
        needsRecovery: () => condition !== 'healthy',
        isQuitting: () => condition === 'quitting',
      });
      controller.request();
      controller.onScreenUnlock();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(deps.relaunch).not.toHaveBeenCalled();
      expect(deps.readScreenState).not.toHaveBeenCalled();
    },
  );

  it('defers for activity and retries when that work has finished', async () => {
    let busy = true;
    const { deps, controller } = setup({ isBusy: async () => busy });
    controller.request();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deps.onEvent).toHaveBeenLastCalledWith('waiting-for-idle');
    expect(deps.relaunch).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on activity-query errors and unknown or failed screen queries', async () => {
    const { deps, controller } = setup();
    vi.mocked(deps.readScreenState)
      .mockReturnValueOnce('unknown')
      .mockImplementationOnce(() => {
        throw new Error('screen unavailable');
      });
    vi.mocked(deps.isBusy).mockRejectedValueOnce(new Error('storage unavailable'));
    controller.request();
    await vi.advanceTimersByTimeAsync(63_000);
    expect(deps.relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('recovers from a missed unlock event using the next screen observation', async () => {
    let state: 'locked' | 'idle' = 'locked';
    const { deps, controller } = setup({ readScreenState: () => state });
    controller.request();
    controller.onScreenLock();
    await vi.advanceTimersByTimeAsync(30_000);
    state = 'idle';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it.each(['recovered', 'quitting', 'disposed', 'locked'] as const)(
    'revalidates after the async busy query when %s',
    async (change) => {
      let finish!: (busy: boolean) => void;
      const { deps, controller } = setup({
        isBusy: () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      });
      controller.request();
      await vi.advanceTimersByTimeAsync(3_000);
      if (change === 'recovered') vi.mocked(deps.needsRecovery).mockReturnValue(false);
      if (change === 'quitting') vi.mocked(deps.isQuitting).mockReturnValue(true);
      if (change === 'disposed') controller.dispose();
      if (change === 'locked') {
        vi.mocked(deps.readScreenState).mockReturnValue('locked');
        controller.onScreenLock();
      }
      finish(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deps.relaunch).not.toHaveBeenCalled();
    },
  );

  it('discards an idle result spanning lock/unlock and gives the new unlock time to settle', async () => {
    let finish!: (busy: boolean) => void;
    const { deps, controller } = setup();
    vi.mocked(deps.isBusy).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    controller.request();
    await vi.advanceTimersByTimeAsync(3_000);
    controller.onScreenLock();
    controller.onScreenUnlock();
    finish(false);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(deps.relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('cancels pending recovery on disposal and observes recovery before its timer fires', async () => {
    const first = setup();
    first.controller.request();
    first.controller.dispose();
    const second = setup();
    second.controller.request();
    vi.mocked(second.deps.needsRecovery).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.deps.relaunch).not.toHaveBeenCalled();
    expect(second.deps.relaunch).not.toHaveBeenCalled();
  });

  it('consumes the attempt if relaunch throws and does not leak native error text', async () => {
    const { deps, controller } = setup({
      relaunch: vi.fn(() => {
        throw new Error('private native details');
      }),
    });
    controller.request();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deps.onEvent).toHaveBeenLastCalledWith('relaunch-failed');
    controller.request();
    controller.onScreenUnlock();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });
});
