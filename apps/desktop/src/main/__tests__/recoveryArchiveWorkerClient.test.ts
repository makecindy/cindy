import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  worker: null as (EventEmitter & { terminate: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }) | null,
  fail: false,
}));
vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(function () {
    if (state.fail) throw new Error('cannot start worker');
    return state.worker;
  }),
}));
import { RECOVERY_ARCHIVE_TIMEOUT_MS, runRecoveryArchiveTask } from '../worktree/recoveryArchiveWorkerClient';

describe('recovery archive worker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0), unref: vi.fn() });
    state.fail = false;
  });
  afterEach(() => { vi.useRealTimers(); });
  it('returns the worker evidence', async () => {
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('message', { ok: true, result: { 'app.asar': { kind: 'file', hash: 'digest', mode: 420 } } });
    state.worker!.emit('exit', 0);
    await expect(result).resolves.toHaveProperty(['app.asar', 'kind'], 'file');
    expect(state.worker!.terminate).toHaveBeenCalledOnce();
    expect(state.worker!.unref).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.worker!.eventNames()).toEqual([]);
  });
  it.each([0, 1])('rejects an exit without a reply even for exit code %s', async (code) => {
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('exit', code);
    await expect(result).rejects.toThrow('exited before replying');
  });
  it('propagates archive verification failures', async () => {
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('message', { ok: false, error: 'archive content does not match worktree inventory' });
    await expect(result).rejects.toThrow('archive content does not match');
  });
  it('terminates a nonresponsive worker before releasing its caller', async () => {
    let terminated!: (code: number) => void;
    state.worker!.terminate.mockReturnValue(new Promise<number>((resolve) => { terminated = resolve; }));
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    let settled = false;
    const checked = expect(result).rejects.toThrow('inventory timed out');
    void result.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RECOVERY_ARCHIVE_TIMEOUT_MS);
    expect(state.worker!.terminate).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    // A late result or error must not overtake timeout/termination.
    state.worker!.emit('message', { ok: true, result: {} });
    state.worker!.emit('error', new Error('racing error'));
    terminated(1);
    await checked;
    expect(state.worker!.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('surfaces termination failures instead of reporting success', async () => {
    state.worker!.terminate.mockRejectedValue(new Error('termination failed'));
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('message', { ok: true, result: {} });
    await expect(result).rejects.toThrow('termination failed');
  });
  it('rejects worker startup and runtime errors', async () => {
    state.fail = true;
    await expect(runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' })).rejects.toThrow('cannot start');
    state.fail = false;
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('error', new Error('worker crashed'));
    await expect(result).rejects.toThrow('worker crashed');
  });
});
