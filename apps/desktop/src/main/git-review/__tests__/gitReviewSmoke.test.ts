import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runGit } from '../gitRunner';
import { readStatus } from '../statusReader';
import type { ReviewScope } from '../types';

let repoPath: string | null = null;

function scope(): ReviewScope {
  if (!repoPath) throw new Error('smoke repository is not initialized');
  return {
    sessionId: 'smoke',
    workdir: repoPath,
    worktreePath: repoPath,
    workingDir: repoPath,
    repoRoot: repoPath,
    branch: 'main',
    headOid: null,
    isDetached: false,
    isUnborn: true,
    source: 'worktree',
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
}

afterEach(async () => {
  if (!repoPath) return;
  const cleanupPath = repoPath;
  repoPath = null;
  await fs.rm(cleanupPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('git-review real Git smoke', () => {
  it('initializes a repository and reads its untracked status', async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-git-review-smoke-'));
    await runGit(['init', '-b', 'main'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'smoke.txt'), 'smoke\n');

    const status = await readStatus(scope());

    expect(status).toMatchObject({
      dirty: true,
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 1,
    });
    expect(status.files).toContainEqual(expect.objectContaining({
      path: 'smoke.txt',
      worktreeStatus: 'untracked',
    }));
  });
});
