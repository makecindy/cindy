import { afterEach, describe, expect, it, vi } from 'vitest';
import { restartBotRuntime } from '../botRuntimeRestart.js';

afterEach(() => vi.useRealTimers());

function harness() {
  return {
    stopInput: vi.fn(),
    withSessionLock: async <T>(_id: string, run: () => Promise<T>) => run(),
    rebuild: vi.fn(async (_id: string, assertCurrent: () => void) => assertCurrent()),
    onClosed: vi.fn(),
  };
}

describe('Bot runtime restart', () => {
  it('stops old input before rebuilding and publishes completion only afterwards', async () => {
    const deps = harness();
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      assertCurrent();
      expect(deps.stopInput).toHaveBeenCalledWith('canonical');
      expect(deps.onClosed).not.toHaveBeenCalled();
    });
    await restartBotRuntime('canonical', vi.fn(), deps);
    expect(deps.onClosed).toHaveBeenCalledWith('canonical');
  });

  it('returns a bounded failure and prevents a late close from committing a rebuild', async () => {
    vi.useFakeTimers();
    const deps = harness();
    let closed!: () => void;
    const close = new Promise<void>((resolve) => { closed = resolve; });
    const commit = vi.fn();
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      await close;
      assertCurrent();
      commit();
    });
    const restart = restartBotRuntime('canonical', vi.fn(), deps);
    const failed = expect(restart).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    closed();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).not.toHaveBeenCalled();
    expect(deps.onClosed).not.toHaveBeenCalled();
  });

  it('does not restart after the data owner changes while waiting for the send lock', async () => {
    const deps = harness();
    let current = true;
    deps.withSessionLock = async (_id, run) => { current = false; return run(); };
    await expect(restartBotRuntime('canonical', () => {
      if (!current) throw new Error('owner changed');
    }, deps)).rejects.toThrow('owner changed');
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(deps.onClosed).not.toHaveBeenCalled();
  });
});
