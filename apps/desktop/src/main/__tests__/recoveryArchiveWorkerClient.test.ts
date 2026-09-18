import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ worker: null as EventEmitter | null, fail: false }));
vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(function () {
    if (state.fail) throw new Error('cannot start worker');
    return state.worker;
  }),
}));
import { runRecoveryArchiveTask } from '../worktree/recoveryArchiveWorkerClient';

describe('recovery archive worker lifecycle', () => {
  beforeEach(() => { state.worker = new EventEmitter(); state.fail = false; });
  it('returns the worker evidence', async () => {
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('message', { ok: true, result: { 'app.asar': { kind: 'file', hash: 'digest', mode: 420 } } });
    state.worker!.emit('exit', 0);
    await expect(result).resolves.toHaveProperty(['app.asar', 'kind'], 'file');
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
  it('rejects worker startup and runtime errors', async () => {
    state.fail = true;
    await expect(runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' })).rejects.toThrow('cannot start');
    state.fail = false;
    const result = runRecoveryArchiveTask({ operation: 'inventory', root: '/fixture' });
    state.worker!.emit('error', new Error('worker crashed'));
    await expect(result).rejects.toThrow('worker crashed');
  });
});
