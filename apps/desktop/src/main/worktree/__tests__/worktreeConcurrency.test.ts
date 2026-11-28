/**
 * Test value (engineering-conventions §3.2)
 * Basis: P1-1 worktree concurrency governance (symlink realpath serialization, global Multibox cap,
 * abortable queue waiting).
 * Coverage gap: existing WorktreeManager tests only checked same-string path serialization and did
 * not cover symlink aliases, cross-repo Multibox concurrency cap, or immediate abort while queued.
 * Minimal failing input: two concurrent calls on symlink/canonical aliases or two different Multibox
 * repos, plus an aborted waiter between active and third waiter.
 * Tier: unit (temp dir for realpath/symlink only; no git subprocesses or timers >= 100ms).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isMultiboxHeavyOpQueueBusy,
  isRepoWorktreeQueueBusy,
  isWorktreeCreationQueueBusy,
  resetWorktreeConcurrencyForTest,
  withMultiboxHeavyOpQueue,
  withRepoWorktreeQueue,
} from '../worktreeConcurrency.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetWorktreeConcurrencyForTest();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('worktreeConcurrency', () => {
  it('serializes symlink aliases to the same repository in FIFO order and supports early release', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-concurrency-'));
    tempDirs.push(root);
    const realRepo = path.join(root, 'repo-real');
    const aliasRepo = path.join(root, 'repo-link');
    await fs.mkdir(realRepo);
    await fs.symlink(realRepo, aliasRepo, 'dir');

    const order: string[] = [];
    const firstGate = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();
    let releaseFirstQueue!: () => void;

    const first = withRepoWorktreeQueue(realRepo, async (releaseQueue) => {
      order.push('first:start');
      releaseFirstQueue = releaseQueue;
      firstEntered.resolve();
      await firstGate.promise;
      order.push('first:after-gate');
    });
    await firstEntered.promise;

    expect(await isRepoWorktreeQueueBusy(aliasRepo)).toBe(true);
    expect(await isWorktreeCreationQueueBusy(aliasRepo, false)).toBe(true);

    const secondQueued = deferred();
    const second = withRepoWorktreeQueue(
      aliasRepo,
      async () => {
        order.push('second:start');
        secondEntered.resolve();
      },
      {
        onQueueWaitStart: () => {
          secondQueued.resolve();
        },
      },
    );

    // Wait for async fs.realpath canonicalization and entry into the waiter queue.
    await secondQueued.promise;
    expect(order).toEqual(['first:start']);

    // Releasing queue early unblocks second while first finishes remaining post-queue work.
    releaseFirstQueue();
    await secondEntered.promise;
    await second;
    expect(order).toEqual(['first:start', 'second:start']);

    firstGate.resolve();
    await first;
    expect(await isRepoWorktreeQueueBusy(realRepo)).toBe(false);
  });

  it('caps process-wide Multibox operations at 1 across different repos while leaving non-Multibox repos concurrent', async () => {
    const repoA = path.join(os.tmpdir(), 'wt-mb-repo-a');
    const repoB = path.join(os.tmpdir(), 'wt-mb-repo-b');

    // Non-Multibox across different repos runs concurrently.
    const aEntered = deferred();
    const bEntered = deferred();
    const releaseBoth = deferred();
    const nonMbA = withRepoWorktreeQueue(repoA, async () => {
      aEntered.resolve();
      await releaseBoth.promise;
    });
    const nonMbB = withRepoWorktreeQueue(repoB, async () => {
      bEntered.resolve();
      await releaseBoth.promise;
    });
    await Promise.all([aEntered.promise, bEntered.promise]);
    releaseBoth.resolve();
    await Promise.all([nonMbA, nonMbB]);

    // Multibox across different repos serializes via the global Multibox queue.
    const mbFirstEntered = deferred();
    const mbFirstRelease = deferred();
    const mbOrder: string[] = [];
    let mbSecondQueued = false;

    const mbFirst = withMultiboxHeavyOpQueue(async () => {
      mbOrder.push('mb1:start');
      mbFirstEntered.resolve();
      await mbFirstRelease.promise;
      mbOrder.push('mb1:end');
    });
    await mbFirstEntered.promise;

    expect(isMultiboxHeavyOpQueueBusy()).toBe(true);
    expect(await isWorktreeCreationQueueBusy(repoB, true)).toBe(true);
    expect(await isWorktreeCreationQueueBusy(repoB, false)).toBe(false);

    const mbSecond = withMultiboxHeavyOpQueue(
      async () => {
        mbOrder.push('mb2:start');
      },
      {
        onQueueWaitStart: () => {
          mbSecondQueued = true;
        },
      },
    );

    expect(mbSecondQueued).toBe(true);
    expect(mbOrder).toEqual(['mb1:start']);

    mbFirstRelease.resolve();
    await Promise.all([mbFirst, mbSecond]);
    expect(mbOrder).toEqual(['mb1:start', 'mb1:end', 'mb2:start']);
    expect(isMultiboxHeavyOpQueueBusy()).toBe(false);
  });

  it('aborts queued waiters immediately without blocking subsequent waiters', async () => {
    const repo = path.join(os.tmpdir(), 'wt-abort-repo');
    const firstEntered = deferred();
    const firstRelease = deferred();
    const ac = new AbortController();

    const first = withRepoWorktreeQueue(repo, async () => {
      firstEntered.resolve();
      await firstRelease.promise;
    });
    await firstEntered.promise;

    const second = withRepoWorktreeQueue(repo, async () => 'should-not-run', { signal: ac.signal });
    const third = withRepoWorktreeQueue(repo, async () => 'third-ran');

    ac.abort(new Error('Task deleted while queued'));
    await expect(second).rejects.toThrow('Task deleted while queued');

    firstRelease.resolve();
    await first;
    await expect(third).resolves.toBe('third-ran');
    expect(await isRepoWorktreeQueueBusy(repo)).toBe(false);

    // Same guarantee for Multibox heavy-op queue.
    const mbEntered = deferred();
    const mbRelease = deferred();
    const mbAc = new AbortController();

    const mb1 = withMultiboxHeavyOpQueue(async () => {
      mbEntered.resolve();
      await mbRelease.promise;
    });
    await mbEntered.promise;

    const mb2 = withMultiboxHeavyOpQueue(async () => 'never', { signal: mbAc.signal });
    const mb3 = withMultiboxHeavyOpQueue(async () => 'mb3-ok');

    mbAc.abort(new Error('Cancelled in multibox queue'));
    await expect(mb2).rejects.toThrow('Cancelled in multibox queue');

    mbRelease.resolve();
    await mb1;
    await expect(mb3).resolves.toBe('mb3-ok');
  });
});
