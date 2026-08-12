/**
 * resolveMemoryScopeKey — worktree 归一化 (#2379) 的真实 Git 组合矩阵。
 *
 * 属于 git-integration tier (`pnpm test:git-integration`), 不在默认 unit
 * tier 运行 (engineering-conventions §3.1: 每个用例都要建临时仓库 / linked
 * worktree / separate-git-dir clone, 反复 spawn git 子进程)。默认层的
 * fake probe 覆盖与唯一 smoke 见 scope-resolver.test.ts。
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  __clearMemoryScopeKeyCacheForTests,
  resolveMemoryScopeKey,
} from './scope-resolver.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  __clearMemoryScopeKeyCacheForTests();
});

describe.skipIf(!gitAvailable())('resolveMemoryScopeKey — 真实临时 git 仓库矩阵', () => {
  async function makeFixture() {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-')));
    const repoRoot = path.join(tmpRoot, 'repo');
    const wt1 = path.join(tmpRoot, 'wt1');
    const wt2 = path.join(tmpRoot, 'wt2');
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });

    await fs.mkdir(repoRoot, { recursive: true });
    git(['init'], repoRoot);
    git(['config', 'user.email', 'test@example.com'], repoRoot);
    git(['config', 'user.name', 'scope-resolver-test'], repoRoot);
    git(['commit', '--allow-empty', '-m', 'init'], repoRoot);
    git(['worktree', 'add', '-b', 'wt1-branch', wt1], repoRoot);
    git(['worktree', 'add', '-b', 'wt2-branch', wt2], repoRoot);
    await fs.mkdir(path.join(repoRoot, 'apps', 'a'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'apps', 'b'), { recursive: true });
    await fs.mkdir(path.join(wt1, 'apps', 'a'), { recursive: true });
    await fs.mkdir(path.join(wt2, 'apps', 'a'), { recursive: true });
    await fs.mkdir(path.join(wt1, 'apps', 'only-in-wt'), { recursive: true });

    const cleanup = async () => {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
    };
    return { tmpRoot, repoRoot, wt1, wt2, git, cleanup };
  }

  it('linked worktree 根 cwd → 主仓根', async () => {
    const f = await makeFixture();
    try {
      expect(await resolveMemoryScopeKey(f.wt1)).toBe(f.repoRoot);
    } finally {
      await f.cleanup();
    }
  });

  it('worktree 子目录 cwd → 主仓根 + 相对子路径', async () => {
    const f = await makeFixture();
    try {
      expect(await resolveMemoryScopeKey(path.join(f.wt1, 'apps', 'a'))).toBe(
        path.join(f.repoRoot, 'apps', 'a'),
      );
    } finally {
      await f.cleanup();
    }
  });

  it('子目录在主仓不存在也按字符串映射 (scope key 是身份, 不是磁盘事实)', async () => {
    const f = await makeFixture();
    try {
      expect(await resolveMemoryScopeKey(path.join(f.wt1, 'apps', 'only-in-wt'))).toBe(
        path.join(f.repoRoot, 'apps', 'only-in-wt'),
      );
    } finally {
      await f.cleanup();
    }
  });

  it('两个 linked worktree 的同相对子路径命中同一 scope key', async () => {
    const f = await makeFixture();
    try {
      const k1 = await resolveMemoryScopeKey(path.join(f.wt1, 'apps', 'a'));
      const k2 = await resolveMemoryScopeKey(path.join(f.wt2, 'apps', 'a'));
      expect(k1).toBe(k2);
      expect(k1).toBe(path.join(f.repoRoot, 'apps', 'a'));
    } finally {
      await f.cleanup();
    }
  });

  it('主仓内 cwd (根与子目录) 原样返回 — 非 worktree 场景行为不变', async () => {
    const f = await makeFixture();
    try {
      expect(await resolveMemoryScopeKey(f.repoRoot)).toBe(f.repoRoot);
      expect(await resolveMemoryScopeKey(path.join(f.repoRoot, 'apps', 'b'))).toBe(
        path.join(f.repoRoot, 'apps', 'b'),
      );
    } finally {
      await f.cleanup();
    }
  });

  it('git clone --separate-git-dir 的 checkout 不归一化 (Codex review 第一轮场景)', async () => {
    const f = await makeFixture();
    try {
      const storage = path.join(f.tmpRoot, 'storage', '.git');
      const checkout = path.join(f.tmpRoot, 'separate-checkout');
      // git 不会创建 --separate-git-dir 的父目录
      await fs.mkdir(path.dirname(storage), { recursive: true });
      f.git(['clone', '--separate-git-dir', storage, f.repoRoot, checkout], f.tmpRoot);
      const sub = path.join(checkout, 'apps', 'a');
      await fs.mkdir(sub, { recursive: true });
      expect(await resolveMemoryScopeKey(checkout)).toBe(checkout);
      expect(await resolveMemoryScopeKey(sub)).toBe(sub);
    } finally {
      await f.cleanup();
    }
  });

  it('主仓是 clone --separate-git-dir (无 core.worktree 指针): 跟随 git worktree list 的 canonical 答案 (已知限制)', async () => {
    const f = await makeFixture();
    try {
      const storage = path.join(f.tmpRoot, 'storage2', '.git');
      const main = path.join(f.tmpRoot, 'separate-main');
      const wt3 = path.join(f.tmpRoot, 'wt3');
      await fs.mkdir(path.dirname(storage), { recursive: true });
      f.git(['clone', '--separate-git-dir', storage, f.repoRoot, main], f.tmpRoot);
      f.git(['worktree', 'add', '-b', 'wt3-branch', wt3], main);
      const sub = path.join(wt3, 'apps', 'a');
      await fs.mkdir(sub, { recursive: true });
      // clone --separate-git-dir 不写 core.worktree, git 自身也无法反推真实
      // checkout: `git worktree list` 把 gitdir 父目录报为主工作树 (连从真实
      // checkout 里跑都一样)。resolver 跟随 git 的 canonical 答案, 该布局下
      // 所有 worktree 共享同一 scope; 主 checkout 会话按契约不归一化。
      const canonical = path.dirname(storage);
      expect(await resolveMemoryScopeKey(wt3)).toBe(canonical);
      expect(await resolveMemoryScopeKey(sub)).toBe(path.join(canonical, 'apps', 'a'));
    } finally {
      await f.cleanup();
    }
  });

  it('非 git 目录原样返回', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-nogit-')));
    try {
      expect(await resolveMemoryScopeKey(dir)).toBe(dir);
    } finally {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上偶发 EBUSY — temp 目录交给 OS 清理 */
      }
    }
  });
});
