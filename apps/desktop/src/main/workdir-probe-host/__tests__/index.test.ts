import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { once: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
}));

import { canRecreateOwnerWorkingDirectory, createWorkingDirectoryRecovery } from '../../maker-ipc/workingDirectoryRecovery.js';
import { MainProcessWorkdirProbeClient } from '../MainProcessWorkdirProbeClient.js';
import { mkdirWorkingDirectory, statWorkingDirectory, workdirProbeHostClient } from '../index.js';

describe('workdir probe wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(workdirProbeHostClient, 'probe').mockResolvedValue({ ok: true, isDirectory: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('normalizes equivalent paths before single-flight deduplication', async () => {
    const dir = path.join('relative', '..', 'workspace');

    await expect(statWorkingDirectory(dir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    expect(workdirProbeHostClient.probe).toHaveBeenCalledWith(dir, path.resolve(dir), 5_000, 'probe', undefined);
  });

  // #10553, unit tier: an immediate mkdir spy missed invalidation while queued.
  // Exercise real recovery, production adapters and queue, with only fs injected.
  describe.each(['original', 'fallback'] as const)('queued %s recreation', (kind) => {
    it.each(['clear', 'owner-switch', 'unchanged'] as const)('checks %s at write dispatch', async (change) => {
      const root = path.resolve('test-profile');
      let owner = path.join(root, 'owners', 'first');
      const original = path.join(owner, 'bots', 'buddy', 'workspace');
      const fallback = path.join(owner, 'dialogues', 'recovery');
      const target = kind === 'original' ? original : fallback;
      const blockingDir = path.join(root, 'slow');
      const slot = Promise.withResolvers<{ isDirectory(): boolean }>();
      const queued = Promise.withResolvers<void>();
      const mkdir = vi.fn(async () => {});
      let blocker: Promise<unknown> | undefined;
      const client = new MainProcessWorkdirProbeClient({
        log: { warn: vi.fn() }, maxInFlight: 1,
        fs: {
          stat: async (dir) => {
            if (dir === blockingDir) return slot.promise;
            if (dir === target) {
              blocker ??= client.probe(blockingDir, blockingDir, 5_000);
              throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
            return { isDirectory: () => true };
          },
          mkdir, realpath: async (dir) => dir, readdir: async () => [],
        },
      });
      vi.mocked(workdirProbeHostClient.probe).mockImplementation((...args) => {
        const result = client.probe(...args);
        if (args[3] === 'mkdir') queued.resolve();
        return result;
      });
      const recovery = createWorkingDirectoryRecovery({
        stat: statWorkingDirectory, mkdir: mkdirWorkingDirectory,
        canRecreateDirectory: (dir) => canRecreateOwnerWorkingDirectory(root, owner, dir),
      }, kind === 'fallback' ? async () => fallback : undefined);
      try {
        if (kind === 'fallback') {
          expect(await recovery.recover('task', original, null, [], 'unrestored-worktree')).toBe(true);
        }
        const recovering = recovery.recover('task', original);
        await queued.promise;
        expect(mkdir).not.toHaveBeenCalled();
        if (change === 'clear') recovery.clear();
        if (change === 'owner-switch') owner = path.join(root, 'owners', 'second');
        slot.resolve({ isDirectory: () => true });
        expect(await recovering).toBe(change === 'unchanged');
        expect(mkdir.mock.calls).toEqual(change === 'unchanged' ? [[target]] : []);
        if (change === 'clear') expect(recovery.peek('task')).toBeNull();
      } finally {
        slot.resolve({ isDirectory: () => true });
        client.dispose();
        await blocker;
      }
    });
  });
});
