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
  looksLikeWindowsLocalPath,
  normalizeWindowsLocalScopeKey,
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
   * resolver 的两种探测: rev-parse 单次返回 toplevel/git-dir/common-dir/
   * superproject 四行 (无 superproject 时第四行为空);
   * 仅在真 linked worktree 或 worktree 内 submodule 时再调
   * `worktree list --porcelain` 取主仓根。不传 mainRoot 表示该用例不允许
   * 出现第二次 spawn (在更早的分支就已回落)。
   */
  const probeFor =
    (
      toplevel: string,
      gitDir: string,
      commonDir: string,
      mainRoot?: string,
      superproject = '',
    ): GitProbe =>
    async (args) => {
      if (args.includes('worktree')) {
        if (mainRoot === undefined) throw new Error('worktree list should not be spawned');
        return `worktree ${mainRoot}\n`;
      }
      return `${toplevel}\n${gitDir}\n${commonDir}\n${superproject}\n`;
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

  it('主仓内 submodule (gitdir == common-dir + superproject == 主仓根) → 原样返回', async () => {
    // 有 superproject 时仍会调 worktree list 确认外层不是 linked worktree;
    // 主仓根与 superproject 相同则保持原路径。
    const probe = probeFor(
      '/main/mod',
      '/main/.git/modules/mod',
      '/main/.git/modules/mod',
      '/main',
      '/main',
    );
    expect(await resolveMemoryScopeKey('/main/mod', null, { execGit: probe })).toBe('/main/mod');
  });

  it('linked worktree 内 submodule → 主仓 submodule 路径 (Codex 3974808633)', async () => {
    const probe = probeFor(
      '/wt/mod',
      '/main/.git/worktrees/wt/modules/mod',
      '/main/.git/worktrees/wt/modules/mod',
      '/main',
      '/wt',
    );
    const mapped = path.join(path.resolve('/main'), 'mod');
    expect(await resolveMemoryScopeKey('/wt/mod', null, { execGit: probe })).toBe(
      process.platform === 'win32' ? mapped.replace(/\\/g, '/') : mapped,
    );
  });

  it('linked worktree 内二级 submodule 沿 superproject 链归一到主仓 (Codex 3974808633)', async () => {
    const abs = (p: string) => path.resolve(p);
    const inner = abs('/wt/mod/inner');
    const parentMod = abs('/wt/mod');
    const wt = abs('/wt');
    const main = abs('/main');
    const byCwd: Record<
      string,
      { toplevel: string; gitDir: string; commonDir: string; superproject: string }
    > = {
      [inner]: {
        toplevel: inner,
        gitDir: abs('/main/.git/worktrees/wt/modules/mod/modules/inner'),
        commonDir: abs('/main/.git/worktrees/wt/modules/mod/modules/inner'),
        superproject: parentMod,
      },
      [parentMod]: {
        toplevel: parentMod,
        gitDir: abs('/main/.git/worktrees/wt/modules/mod'),
        commonDir: abs('/main/.git/worktrees/wt/modules/mod'),
        superproject: wt,
      },
      [wt]: {
        toplevel: wt,
        gitDir: abs('/main/.git/worktrees/wt'),
        commonDir: abs('/main/.git'),
        superproject: '',
      },
    };
    const probe: GitProbe = async (args, cwd) => {
      if (args.includes('worktree')) return `worktree ${main}\n`;
      const rec = byCwd[path.normalize(cwd)] ?? byCwd[cwd];
      if (!rec) throw new Error(`unexpected cwd ${cwd}`);
      return `${rec.toplevel}\n${rec.gitDir}\n${rec.commonDir}\n${rec.superproject}\n`;
    };
    const mapped = path.join(main, 'mod', 'inner');
    expect(await resolveMemoryScopeKey(inner, null, { execGit: probe })).toBe(
      process.platform === 'win32' ? mapped.replace(/\\/g, '/') : mapped,
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
    const mapped = path.join(path.resolve('/real/checkout'), 'apps', 'a');
    expect(await resolveMemoryScopeKey('/fake/wt/apps/a', null, { execGit: probe })).toBe(
      process.platform === 'win32' ? mapped.replace(/\\/g, '/') : mapped,
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

  it('成功归一化 sticky: TTL 过期后不重新探测 (Codex 3968440903)', async () => {
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
    expect(calls).toBe(2);
  });

  it('sticky 正缓存: TTL 后 git 失败仍返回 canonical, 不漂回 worktree (Codex 3968440903)', async () => {
    const abs = (p: string) => (process.platform === 'win32' ? `C:${p}` : p);
    const cwd = abs('/repo/.cindy-worktrees/feat');
    let fail = false;
    let tick = 0;
    const base = probeFor(
      abs('/repo/.cindy-worktrees/feat'),
      abs('/repo/.git/worktrees/feat'),
      abs('/repo/.git'),
      abs('/repo'),
    );
    const probe: GitProbe = async (args, probeCwd) => {
      if (fail) throw Object.assign(new Error('timed out'), { killed: true });
      return base(args, probeCwd);
    };
    const first = await resolveMemoryScopeKey(cwd, null, { execGit: probe, now: () => tick });
    expect(first).toBe(process.platform === 'win32' ? 'C:/repo' : abs('/repo'));
    tick = 61_000;
    fail = true;
    const second = await resolveMemoryScopeKey(cwd, null, { execGit: probe, now: () => tick });
    expect(second).toBe(first);
  });

  it('负结果 TTL 过期后重新探测 (Codex 3968440903)', async () => {
    let calls = 0;
    let tick = 0;
    const probe: GitProbe = async () => {
      calls += 1;
      throw Object.assign(new Error('not a git repository'), { code: 128 });
    };
    await resolveMemoryScopeKey('/fake/neg-ttl', null, { execGit: probe, now: () => tick });
    tick = 61_000;
    await resolveMemoryScopeKey('/fake/neg-ttl', null, { execGit: probe, now: () => tick });
    expect(calls).toBe(2);
  });

  it('合法子目录名以两点开头不判逃逸 (Codex 3974018445)', async () => {
    const abs = (p: string) => (process.platform === 'win32' ? `C:${p}` : p);
    const probe = probeFor(
      abs('/repo/.cindy-worktrees/feat'),
      abs('/repo/.git/worktrees/feat'),
      abs('/repo/.git'),
      abs('/repo'),
    );
    const key = await resolveMemoryScopeKey(
      abs('/repo/.cindy-worktrees/feat/..config'),
      null,
      { execGit: probe },
    );
    expect(key).toBe(
      process.platform === 'win32' ? 'C:/repo/..config' : path.join(abs('/repo'), '..config'),
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows 正反斜杠 cwd 命中同一缓存 (分隔符规范化后 cache key 稳定)',
    async () => {
      let calls = 0;
      const probe: GitProbe = async () => {
        calls += 1;
        throw Object.assign(new Error('not a git repository'), { code: 128 });
      };
      await resolveMemoryScopeKey('C:\\cache-mix\\repo', null, { execGit: probe });
      await resolveMemoryScopeKey('C:/cache-mix/repo', null, { execGit: probe });
      await resolveMemoryScopeKey('\\\\server\\share\\r', null, { execGit: probe });
      await resolveMemoryScopeKey('//server/share/r', null, { execGit: probe });
      expect(calls).toBe(2);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'Windows 反斜杠 cwd 与正斜杠主仓收成同一正斜杠 key (Codex #2519 第十九轮 UNC/分隔符)',
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
      expect(key).toBe('C:/repo/apps/a');
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
describe('normalizeWindowsLocalScopeKey — 路径边界 (Codex #2519 第十九轮)', () => {
  // 路径边界审计 (分隔符 / 盘符 / UNC / \\?\\ / 空与相对盘符 / 特殊字符)
  // 已由下列用例覆盖。symlink / junction / 大小写:
  //  - 不额外 realpath, scope 跟 git toplevel (与 inode/junction 目标解耦)
  //  - 不把路径段改成小写 (sanitizeWorkdir 区分 C--Users 与 c--users)
  //  - cache/samePath 已大小写不敏感

  it('UNC 正斜杠与反斜杠收成同一 //server/share 形态', () => {
    expect(normalizeWindowsLocalScopeKey('\\\\server\\share\\repo')).toBe(
      '//server/share/repo',
    );
    expect(normalizeWindowsLocalScopeKey('//server/share/repo')).toBe('//server/share/repo');
    expect(normalizeWindowsLocalScopeKey('//server/share/repo/')).toBe('//server/share/repo');
    expect(normalizeWindowsLocalScopeKey('//server//share///repo')).toBe('//server/share/repo');
    expect(looksLikeWindowsLocalPath('//server/share/repo')).toBe(true);
  });

  it('长路径 \\\\?\\ 与 \\\\?\\UNC\\ 前缀剥掉后再规范化', () => {
    expect(normalizeWindowsLocalScopeKey('\\\\?\\C:\\repo\\apps')).toBe('C:/repo/apps');
    expect(normalizeWindowsLocalScopeKey('\\\\?\\UNC\\server\\share\\repo')).toBe(
      '//server/share/repo',
    );
  });

  it('非 DOS 设备路径保留 \\\\?\\ 根前缀 (Codex 3974674292)', () => {
    expect(
      normalizeWindowsLocalScopeKey(
        '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\repo',
      ),
    ).toBe('//?/Volume{12345678-1234-1234-1234-123456789abc}/repo');
    expect(
      normalizeWindowsLocalScopeKey('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo'),
    ).toBe('//?/GLOBALROOT/Device/HarddiskVolume1/repo');
    expect(
      looksLikeWindowsLocalPath(
        '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\repo',
      ),
    ).toBe(true);
  });

  it('盘符: 尾随斜杠/重复斜杠/根盘/相对盘符/混合分隔符', () => {
    expect(normalizeWindowsLocalScopeKey('C:/repo\\apps//a/')).toBe('C:/repo/apps/a');
    expect(normalizeWindowsLocalScopeKey('C:/')).toBe('C:/');
    expect(normalizeWindowsLocalScopeKey('C:\\')).toBe('C:/');
    expect(normalizeWindowsLocalScopeKey('C:')).toBe('C:'); // 裸盘符 drive-relative, 不抬成 C:/
    expect(normalizeWindowsLocalScopeKey('C:foo')).toBe('C:foo'); // 不抬成绝对
    expect(normalizeWindowsLocalScopeKey('C:/repo with space/项目')).toBe('C:/repo with space/项目');
  });

  it('空串 / ssh / bot 不改写', () => {
    expect(normalizeWindowsLocalScopeKey('')).toBe('');
    expect(normalizeWindowsLocalScopeKey('ssh:host:/repo')).toBe('ssh:host:/repo');
    expect(normalizeWindowsLocalScopeKey('bot:alice')).toBe('bot:alice');
  });
});

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
      const mapped = path.join(repoRoot, 'apps', 'a');
      expect(await resolveMemoryScopeKey(sub)).toBe(
        process.platform === 'win32' ? mapped.replace(/\\/g, '/') : mapped,
      );
    } finally {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
    }
  });
});
