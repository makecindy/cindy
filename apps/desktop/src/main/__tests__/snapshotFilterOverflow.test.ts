/**
 * `git status` 输出溢出 exec 缓冲时的失败关闭语义(unit,mock git 执行层):
 * - buildSnapshotFilePlan 标记 statusTruncated(脏文件视图未知 ≠ 无脏文件);
 * - listUnprotectedPaths 返回 null(读侧必须失败关闭);
 * - createShadowSavepoint 直接抛 status-overflow(不拍静默漏文件的基线)。
 * legacy 分支提交路径保留历史上的静默降级行为,不在本文件覆盖范围。
 */

import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitExecMock = vi.hoisted(() => vi.fn());

vi.mock('../worktree/gitExec', () => {
  class GitExecError extends Error {
    stderr = '';
    stdout = '';
    exitCode: number | null = null;
    cause: unknown;
    constructor(_input: unknown) {
      super('mock git exec error');
    }
  }
  return {
    GitExecError,
    gitExec: (...args: unknown[]) => gitExecMock(...args),
  };
});

import { GitExecError } from '../worktree/gitExec';
import { buildSnapshotFilePlan } from '../git-snapshot/snapshotFileFilter';
import {
  createShadowSavepoint,
  listUnprotectedPaths,
  SnapshotBlockedByGitStateError,
} from '../git-snapshot/gitSnapshotService';

// 不存在的路径:detectBlockedGitState 的 rev-parse 输出解析后 lstat 失败,
// 视为没有进行中的 git 操作。
const REPO = path.join(os.tmpdir(), 'snapshot-overflow-nonexistent-repo');

function installOverflowGitExec(): void {
  gitExecMock.mockImplementation(async (args: readonly string[]) => {
    if (args.includes('status')) {
      const err = new GitExecError({ args: [...args], exitCode: null, stderr: '', stdout: '' });
      err.message = 'spawn maxBuffer length exceeded';
      throw err;
    }
    if (args.includes('--git-path')) {
      return { stdout: 'no-such-marker\n', stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

beforeEach(() => {
  gitExecMock.mockReset();
  installOverflowGitExec();
});

describe('git status overflow fails closed for shadow consumers', () => {
  it('buildSnapshotFilePlan marks the plan as statusTruncated with empty views', async () => {
    const plan = await buildSnapshotFilePlan(REPO);

    expect(plan.statusTruncated).toBe(true);
    expect(plan.includedFiles).toEqual([]);
    expect(plan.skippedFiles).toEqual([]);
  });

  it('listUnprotectedPaths returns null instead of pretending paths are protected', async () => {
    await expect(listUnprotectedPaths(REPO, ['src/a.ts'])).resolves.toBeNull();
  });

  it('createShadowSavepoint refuses to record a baseline on an unknown dirty view', async () => {
    await expect(
      createShadowSavepoint(REPO, {
        sessionId: 's1',
        label: 'baseline',
        meta: { kind: 'turn-start' },
      }),
    ).rejects.toMatchObject({
      name: 'SnapshotBlockedByGitStateError',
      state: { reason: 'status-overflow' },
    });
    expect(SnapshotBlockedByGitStateError).toBeDefined();
  });
});
