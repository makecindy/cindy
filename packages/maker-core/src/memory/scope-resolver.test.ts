/**
 * resolveMemoryScopeKey — worktree 归一化 (#2379) 的单元测试。
 *
 * 两层覆盖:
 *  - 真实临时 git 仓库 (主工作树 + 两个 linked worktree, 仓根与子目录 cwd):
 *    端到端验证「linked worktree cwd → 主仓根 + 相对子路径」映射。
 *  - 注入 fake GitProbe: 失败/超时/非常规布局一律回落 cwd 原样; 缓存命中
 *    不重复 spawn; SSH 分支完全旁路 (不 spawn git)。
 *
 * 与 scope-key.test.ts 的分工: 那边固定 buildMemoryScopeKey 的同步契约
 * (本地原样返回 + SSH 单射); 这边固定 async resolver 的归一化与回落语义。
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  __clearMemoryScopeKeyCacheForTests,
  resolveMemoryScopeKey,
  type GitProbe,
} from './scope-resolver.js';
import { buildMemoryScopeKey } from './storage.js';

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

describe('resolveMemoryScopeKey — SSH 与空输入旁路', () => {
  it('SSH remote 会话产出 ssh: 复合键且不 spawn git', async () => {
    let probeCalls = 0;
    const probe: GitProbe = async () => {
      probeCalls += 1;
      throw new Error('should not be called');
    };
    const key = await resolveMemoryScopeKey('/home/me/proj', 'my-host', { execGit: probe });
    expect(key).toBe(buildMemoryScopeKey('/home/me/proj', 'my-host'));
    expect(key).toBe('ssh:my-host:/home/me/proj');
    expect(probeCalls).toBe(0);
  });

  it('空 workingDir 原样返回', async () => {
    expect(await resolveMemoryScopeKey('')).toBe('');
  });
});

describe('resolveMemoryScopeKey — fake probe 回落与缓存', () => {
  const failingProbe =
    (makeErr: () => Error): GitProbe =>
    async () => {
      throw makeErr();
    };

  it('git 不存在 (ENOENT) → 原样返回', async () => {
    const probe = failingProbe(() => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(await resolveMemoryScopeKey('/fake/no-git', null, { execGit: probe })).toBe('/fake/no-git');
  });

  it('非 git 目录 (exit 128) → 原样返回', async () => {
    const probe = failingProbe(() => Object.assign(new Error('not a git repository'), { code: 128 }));
    expect(await resolveMemoryScopeKey('/fake/not-repo', null, { execGit: probe })).toBe(
      '/fake/not-repo',
    );
  });

  it('探测超时 → 原样返回', async () => {
    const probe = failingProbe(() => Object.assign(new Error('timed out'), { killed: true }));
    expect(await resolveMemoryScopeKey('/fake/timeout', null, { execGit: probe })).toBe(
      '/fake/timeout',
    );
  });

  it('common-dir 非 <root>/.git 形态 (bare/非常规布局) → 原样返回', async () => {
    const probe: GitProbe = async (args) => {
      if (args.includes('--show-toplevel')) return '/fake/bare-wt\n';
      return '/fake/repo.git\n'; // common-dir basename 不是 .git
    };
    expect(await resolveMemoryScopeKey('/fake/bare-wt', null, { execGit: probe })).toBe(
      '/fake/bare-wt',
    );
  });

  it('cwd 不在 toplevel 下 (relative 逃逸) → 原样返回', async () => {
    const probe: GitProbe = async (args) => {
      if (args.includes('--show-toplevel')) return '/totally/other\n';
      return '/main/.git\n';
    };
    expect(await resolveMemoryScopeKey('/fake/escape', null, { execGit: probe })).toBe(
      '/fake/escape',
    );
  });

  it('同 cwd 重复解析只 spawn 一轮 git (正结果缓存)', async () => {
    // 平台绝对路径: POSIX 风格 '/repo' 在 Windows 上会被 resolve 到当前盘符,
    // fake 输出直接给平台绝对形态, 让断言与盘符无关。
    const abs = (p: string) => (process.platform === 'win32' ? `C:${p}` : p);
    let calls = 0;
    const probe: GitProbe = async (args) => {
      calls += 1;
      if (args.includes('--show-toplevel')) return `${abs('/repo/.cindy-worktrees/feat')}\n`;
      return `${abs('/repo/.git')}\n`;
    };
    const first = await resolveMemoryScopeKey(abs('/repo/.cindy-worktrees/feat/apps/a'), null, {
      execGit: probe,
    });
    const second = await resolveMemoryScopeKey(abs('/repo/.cindy-worktrees/feat/apps/a'), null, {
      execGit: probe,
    });
    expect(first).toBe(path.join(abs('/repo'), 'apps', 'a'));
    expect(second).toBe(first);
    expect(calls).toBe(2); // toplevel + common-dir 各一次
  });

  it('失败结果同样缓存 (负结果不重复 spawn)', async () => {
    let calls = 0;
    const probe: GitProbe = async () => {
      calls += 1;
      throw Object.assign(new Error('not a git repository'), { code: 128 });
    };
    await resolveMemoryScopeKey('/fake/neg-cache', null, { execGit: probe });
    await resolveMemoryScopeKey('/fake/neg-cache', null, { execGit: probe });
    expect(calls).toBe(2);
  });

  it('TTL 过期后重新探测', async () => {
    let calls = 0;
    let tick = 0;
    const probe: GitProbe = async (args) => {
      calls += 1;
      if (args.includes('--show-toplevel')) return '/repo/.wt/x\n';
      return '/repo/.git\n';
    };
    const now = () => tick;
    await resolveMemoryScopeKey('/repo/.wt/x', null, { execGit: probe, now });
    tick = 30_000;
    await resolveMemoryScopeKey('/repo/.wt/x', null, { execGit: probe, now });
    expect(calls).toBe(2);
    tick = 61_000;
    await resolveMemoryScopeKey('/repo/.wt/x', null, { execGit: probe, now });
    expect(calls).toBe(4);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows 风格路径: git 正斜杠输出 + 反斜杠 cwd 混合归一化',
    async () => {
      const probe: GitProbe = async (args) => {
        if (args.includes('--show-toplevel')) return 'C:/repo/.cindy-worktrees/feat\n';
        return 'C:/repo/.git\n';
      };
      const key = await resolveMemoryScopeKey('C:\\repo\\.cindy-worktrees\\feat\\apps\\a', null, {
        execGit: probe,
      });
      expect(key).toBe('C:\\repo\\apps\\a');
    },
  );
});

describe.skipIf(!gitAvailable())('resolveMemoryScopeKey — 真实临时 git 仓库', () => {
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
    return { tmpRoot, repoRoot, wt1, wt2, cleanup };
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
