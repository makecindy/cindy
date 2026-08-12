/**
 * resolveMemoryScopeKey — worktree 归一化 (#2379) 的单元测试 (默认 unit tier)。
 *
 * 默认层只保留进程内 fake probe 全量覆盖 + 一条真实 Git smoke
 * (engineering-conventions §3.1); 完整真实 Git 矩阵 (多 worktree /
 * separate-git-dir / 主仓内 cwd 等组合语义) 在
 * scope-resolver.git-integration.test.ts, 由 `pnpm test:git-integration` 执行。
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

  /**
   * resolver 的两种探测: rev-parse 单次返回 toplevel/git-dir/common-dir 三行;
   * 仅在 gitdir ≠ common-dir 且 common-dir basename 为 .git 时再调
   * `worktree list --porcelain` 取主仓根。不传 mainRoot 表示该用例不允许
   * 出现第二次 spawn (在更早的分支就已回落)。
   */
  const probeFor =
    (toplevel: string, gitDir: string, commonDir: string, mainRoot?: string): GitProbe =>
    async (args) => {
      if (args.includes('worktree')) {
        if (mainRoot === undefined) throw new Error('worktree list should not be spawned');
        return `worktree ${mainRoot}\n`;
      }
      return `${toplevel}\n${gitDir}\n${commonDir}\n`;
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

  it('separate-git-dir checkout (gitdir == common-dir 且 basename 为 .git) → 原样返回', async () => {
    // `git clone --separate-git-dir=/some/storage/.git` 的 common-dir basename
    // 恰好也是 .git, 不做 gitdir ≠ common-dir 区分会把主仓根错误推导到 git
    // 存储目录 (Codex review on #2399)。
    const probe = probeFor('/fake/checkout', '/some/storage/.git', '/some/storage/.git');
    expect(await resolveMemoryScopeKey('/fake/checkout', null, { execGit: probe })).toBe(
      '/fake/checkout',
    );
  });

  it('common-dir 非 <root>/.git 形态 (bare/非常规布局) → 原样返回', async () => {
    const probe = probeFor('/fake/bare-wt', '/fake/repo.git/worktrees/x', '/fake/repo.git');
    expect(await resolveMemoryScopeKey('/fake/bare-wt', null, { execGit: probe })).toBe(
      '/fake/bare-wt',
    );
  });

  it('cwd 不在 toplevel 下 (relative 逃逸) → 原样返回', async () => {
    const probe = probeFor('/totally/other', '/main/.git/worktrees/w', '/main/.git', '/main');
    expect(await resolveMemoryScopeKey('/fake/escape', null, { execGit: probe })).toBe(
      '/fake/escape',
    );
  });

  it('主仓本身是 separate-git-dir 布局: linked worktree 映射到真实主 checkout', async () => {
    // common-dir 是 git 存储目录 (/storage/.git), dirname 不是工作树;
    // 主仓根必须来自 `worktree list --porcelain` 第一条 (Codex review 第二轮)。
    const probe = probeFor(
      '/fake/wt',
      '/storage/.git/worktrees/w',
      '/storage/.git',
      '/real/checkout',
    );
    expect(await resolveMemoryScopeKey('/fake/wt/apps/a', null, { execGit: probe })).toBe(
      path.join(path.resolve('/real/checkout'), 'apps', 'a'),
    );
  });

  it('worktree list 取不到主仓根 → 原样返回', async () => {
    const probe: GitProbe = async (args) => {
      if (args.includes('worktree')) return '\n'; // 无 worktree 记录
      return '/fake/wt\n/main/.git/worktrees/w\n/main/.git\n';
    };
    expect(await resolveMemoryScopeKey('/fake/wt', null, { execGit: probe })).toBe('/fake/wt');
  });

  it('同 cwd 重复解析只 spawn 一轮 git (正结果缓存)', async () => {
    // 平台绝对路径: POSIX 风格 '/repo' 在 Windows 上会被 resolve 到当前盘符,
    // fake 输出直接给平台绝对形态, 让断言与盘符无关。
    const abs = (p: string) => (process.platform === 'win32' ? `C:${p}` : p);
    let calls = 0;
    const base = probeFor(
      abs('/repo/.cindy-worktrees/feat'),
      abs('/repo/.git/worktrees/feat'),
      abs('/repo/.git'),
      abs('/repo'),
    );
    const probe: GitProbe = async (args, cwd) => {
      calls += 1;
      return base(args, cwd);
    };
    const first = await resolveMemoryScopeKey(abs('/repo/.cindy-worktrees/feat/apps/a'), null, {
      execGit: probe,
    });
    const second = await resolveMemoryScopeKey(abs('/repo/.cindy-worktrees/feat/apps/a'), null, {
      execGit: probe,
    });
    // Windows 上输入是盘符正斜杠形态 (C:/...) — 输出保持正斜杠拼写, 与
    // Desktop 主 checkout 会话的 scope key 一致 (Codex on #2519 第八轮),
    // 不能是 path.join 默认的反斜杠 (会与主 checkout 缓存成两个 Store)。
    expect(first).toBe(
      process.platform === 'win32' ? 'C:/repo/apps/a' : path.join(abs('/repo'), 'apps', 'a'),
    );
    expect(second).toBe(first);
    expect(calls).toBe(2); // rev-parse + worktree list 各一次, 第二轮全缓存
  });

  it('失败结果同样缓存 (负结果不重复 spawn)', async () => {
    let calls = 0;
    const probe: GitProbe = async () => {
      calls += 1;
      throw Object.assign(new Error('not a git repository'), { code: 128 });
    };
    await resolveMemoryScopeKey('/fake/neg-cache', null, { execGit: probe });
    await resolveMemoryScopeKey('/fake/neg-cache', null, { execGit: probe });
    expect(calls).toBe(1);
  });

  it('TTL 过期后重新探测', async () => {
    let calls = 0;
    let tick = 0;
    const base = probeFor('/repo/.wt/x', '/repo/.git/worktrees/x', '/repo/.git', '/repo');
    const probe: GitProbe = async (args, cwd) => {
      calls += 1;
      return base(args, cwd);
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
      const probe = probeFor(
        'C:/repo/.cindy-worktrees/feat',
        'C:/repo/.git/worktrees/feat',
        'C:/repo/.git',
        'C:/repo',
      );
      const key = await resolveMemoryScopeKey('C:\\repo\\.cindy-worktrees\\feat\\apps\\a', null, {
        execGit: probe,
      });
      expect(key).toBe('C:\\repo\\apps\\a');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'Windows 正斜杠输入 → 正斜杠输出 (scope key 拼写与 Desktop 一致, Codex on #2519 第八轮)',
    async () => {
      // Desktop 存正斜杠路径; 反斜杠输出会与主 checkout 会话 (正斜杠 key)
      // 缓存成两个 Store 实例指向同一磁盘目录
      const probe = probeFor(
        'C:/repo/.cindy-worktrees/feat',
        'C:/repo/.git/worktrees/feat',
        'C:/repo/.git',
        'C:/repo',
      );
      const key = await resolveMemoryScopeKey('C:/repo/.cindy-worktrees/feat/apps/a', null, {
        execGit: probe,
      });
      expect(key).toBe('C:/repo/apps/a');
    },
  );
});

// 默认 unit tier 唯一一条真实 Git smoke (§3.1): 端到端打通「真实 git 探测 +
// 映射」主路径。组合矩阵见 scope-resolver.git-integration.test.ts。
describe.skipIf(!gitAvailable())('resolveMemoryScopeKey — 真实 Git smoke', () => {
  it('linked worktree 子目录 cwd → 主仓根 + 相对子路径', async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-')));
    const repoRoot = path.join(tmpRoot, 'repo');
    const wt = path.join(tmpRoot, 'wt');
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      await fs.mkdir(repoRoot, { recursive: true });
      git(['init'], repoRoot);
      git(['config', 'user.email', 'test@example.com'], repoRoot);
      git(['config', 'user.name', 'scope-resolver-test'], repoRoot);
      git(['commit', '--allow-empty', '-m', 'init'], repoRoot);
      git(['worktree', 'add', '-b', 'wt-branch', wt], repoRoot);
      const sub = path.join(wt, 'apps', 'a');
      await fs.mkdir(sub, { recursive: true });
      expect(await resolveMemoryScopeKey(sub)).toBe(path.join(repoRoot, 'apps', 'a'));
    } finally {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
    }
  });
});
