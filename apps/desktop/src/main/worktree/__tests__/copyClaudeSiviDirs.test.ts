/**
 * copyClaudeSiviDirs 回归 —— 自动 worktree 的 .claude/.sivi 复制不得用 baseRepo
 * 旧 checkout 覆盖 sourceBranch 的受控内容(PR #1376 review):被 git 跟踪的文件
 * 由 stageCheckout / 池 reset 按新基底检出,复制只补未跟踪的本地配置;跟踪清单
 * 查询失败退回全量复制(fail-open)。git 层 mock(不 spawn 真进程),fs 夹具建在
 * os.tmpdir。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** baseRepo 索引跟踪清单(ls-files);undefined = 查询失败 */
  lsFilesStdout: undefined as string | undefined,
  /** 目标 worktree HEAD 树清单(ls-tree);undefined = 查询失败 */
  lsTreeStdout: undefined as string | undefined,
}));

vi.mock('../gitExec', () => ({
  gitExec: async (args: readonly string[]) => {
    if (args[0] === 'ls-files') {
      if (mocks.lsFilesStdout === undefined) throw new Error('ls-files failed');
      return { stdout: mocks.lsFilesStdout, stderr: '' };
    }
    if (args[0] === 'ls-tree') {
      if (mocks.lsTreeStdout === undefined) throw new Error('ls-tree failed');
      return { stdout: mocks.lsTreeStdout, stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  },
}));

import { buildWorktreeAddArgs, copyClaudeSiviDirs } from '../WorktreeManager';

let baseRepo: string;
let worktree: string;

async function write(root: string, rel: string, content: string) {
  const p = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

async function read(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

beforeEach(async () => {
  baseRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-cs-base-'));
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-cs-wt-'));
  mocks.lsFilesStdout = undefined;
  mocks.lsTreeStdout = undefined;
});

afterEach(async () => {
  await fs.rm(baseRepo, { recursive: true, force: true });
  await fs.rm(worktree, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('buildWorktreeAddArgs', () => {
  it('带 --no-track:远端引用为起点时不给 cindy/* 分支挂 branch.<name>.remote/merge 跟踪配置', () => {
    const args = buildWorktreeAddArgs(
      'cindy/auto-x1',
      '/repo/.cindy-worktrees/auto-x1',
      'refs/remotes/origin/main',
    );
    // --no-track 抑制 branch.autoSetupMerge 的默认行为:新分支不产生 upstream
    // 跟踪配置,裸 git push/pull 不会误指向远端默认分支
    expect(args).toContain('--no-track');
    const noTrackIdx = args.indexOf('--no-track');
    const bIdx = args.indexOf('-b');
    expect(noTrackIdx).toBeGreaterThan(-1);
    expect(noTrackIdx).toBeLessThan(bIdx); // 在 -b 之前,作用于分支创建
    expect(args.slice(-3)).toEqual([
      'cindy/auto-x1',
      '/repo/.cindy-worktrees/auto-x1',
      'refs/remotes/origin/main',
    ]);
  });
});

describe('copyClaudeSiviDirs', () => {
  it('被跟踪的受控文件不复制:worktree 保留新基底(sourceBranch)检出的版本,不产生 dirty', async () => {
    // baseRepo 旧 checkout 的受控文件(内容旧)
    await write(baseRepo, '.claude/settings.json', 'old-base-content');
    await write(baseRepo, '.sivi/souls.json', 'old-souls');
    // worktree 已由 stageCheckout 按新基底检出(内容新)
    await write(worktree, '.claude/settings.json', 'fresh-source-branch-content');
    await write(worktree, '.sivi/souls.json', 'fresh-souls');
    mocks.lsFilesStdout = '.claude/settings.json\0.sivi/souls.json\0';

    await copyClaudeSiviDirs(baseRepo, worktree);

    expect(await read(worktree, '.claude/settings.json')).toBe('fresh-source-branch-content');
    expect(await read(worktree, '.sivi/souls.json')).toBe('fresh-souls');
  });

  it('基底上已删除的跟踪文件不被补回(否则一创建就 dirty)', async () => {
    // 在 baseRepo 仍被跟踪,但新 sourceBranch 已删除 → worktree 里没有它
    await write(baseRepo, '.claude/removed-on-main.md', 'stale');
    mocks.lsFilesStdout = '.claude/removed-on-main.md\0';

    await copyClaudeSiviDirs(baseRepo, worktree);

    expect(await read(worktree, '.claude/removed-on-main.md')).toBeNull();
  });

  it('baseRepo 未跟踪但 sourceBranch 已开始跟踪 → 本地旧配置不覆盖新基底检出内容', async () => {
    // 上游给仓库新增了受控的 .claude/team-rule.md;本地 baseRepo 还没拉到
    // (索引里没有),但用户曾手写过一份同名未跟踪草稿
    await write(baseRepo, '.claude/team-rule.md', 'my-old-local-draft');
    await write(worktree, '.claude/team-rule.md', 'now-tracked-on-source-branch');
    mocks.lsFilesStdout = ''; // baseRepo 索引没有它
    mocks.lsTreeStdout = '.claude/team-rule.md\0'; // 目标基底 HEAD 树已跟踪

    await copyClaudeSiviDirs(baseRepo, worktree);

    expect(await read(worktree, '.claude/team-rule.md')).toBe('now-tracked-on-source-branch');
  });

  it('未跟踪的本地配置照常补复制', async () => {
    await write(baseRepo, '.claude/settings.json', 'tracked-old');
    await write(baseRepo, '.claude/settings.local.json', 'my-local-secrets-free-config');
    await write(worktree, '.claude/settings.json', 'tracked-new');
    mocks.lsFilesStdout = '.claude/settings.json\0';

    await copyClaudeSiviDirs(baseRepo, worktree);

    expect(await read(worktree, '.claude/settings.local.json')).toBe(
      'my-local-secrets-free-config',
    );
    expect(await read(worktree, '.claude/settings.json')).toBe('tracked-new');
  });

  it('跟踪清单查询失败 → 退回全量复制的旧行为(fail-open)', async () => {
    await write(baseRepo, '.claude/settings.json', 'base-content');
    mocks.lsFilesStdout = undefined; // ls-files 抛错

    await copyClaudeSiviDirs(baseRepo, worktree);

    expect(await read(worktree, '.claude/settings.json')).toBe('base-content');
  });

  it('overwriteExisting:false(restore 路径)与跟踪跳过叠加:已有文件一律不覆盖', async () => {
    await write(baseRepo, '.claude/settings.local.json', 'base-local');
    await write(worktree, '.claude/settings.local.json', 'restored-local');
    mocks.lsFilesStdout = '';

    await copyClaudeSiviDirs(baseRepo, worktree, { overwriteExisting: false });

    expect(await read(worktree, '.claude/settings.local.json')).toBe('restored-local');
  });
});
