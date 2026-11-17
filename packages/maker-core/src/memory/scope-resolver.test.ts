/**
 * resolveMemoryScopeKey — 项目记忆按仓库共用一份的单元测试 (默认 unit tier)。
 *
 * 规则: 本地 cwd 归到它所在仓库的主工作树根 (子目录 / linked worktree /
 * submodule 都不再各有一份); 不在 git 仓库里或探测失败时按 cwd 原样。
 * 历史: #2379 只把 linked worktree 根换回主仓根、子目录仍各自隔离; 2026-11 起
 * 子目录也归到仓库根。
 *
 * 默认层只保留进程内 fake probe 全量覆盖 + 一条真实 Git smoke
 * (engineering-conventions §3.1); 完整真实 Git 矩阵 (多 worktree /
 * separate-git-dir / submodule 等组合语义) 在
 * scope-resolver.git-integration.test.ts, 由 `pnpm test:git-integration` 执行。
 *
 * 与 scope-key.test.ts 的分工: 那边固定 buildMemoryScopeKey 的同步契约
 * (本地原样返回 + SSH 单射); 这边固定 async resolver 的归一化与回落语义。
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Passthrough: only the Windows timeout case below replaces execFile; every other case
// (including the real Git smoke) runs the real one.
const childProcess = vi.hoisted(() => ({
  execFile: null as null | ((file: string, args: string[], ...rest: unknown[]) => unknown),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(
    (...args: unknown[]) =>
      childProcess.execFile
        ? childProcess.execFile(...(args as [string, string[], ...unknown[]]))
        : (actual.execFile as (...a: unknown[]) => unknown)(...args),
    { [custom]: (actual.execFile as unknown as Record<symbol, unknown>)[custom] },
  );
  return { ...actual, execFile };
});

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

  // user:account 是账号级记忆的键 (storage.ts USER_MEMORY_SCOPE_KEY): 和 bot: / ssh:
  // 一样不是本地路径, 当成路径去探测 git 会把它改写成别的键。
  it.each(['bot:cindy', 'ssh:my-host:%2Fhome%2Fme', 'user:account'])(
    '已是复合键 %s 时原样透传且不 spawn git',
    async (key) => {
      let probeCalls = 0;
      const probe: GitProbe = async () => {
        probeCalls += 1;
        throw new Error('should not be called');
      };
      await expect(resolveMemoryScopeKey(key, null, { execGit: probe })).resolves.toBe(key);
      expect(probeCalls).toBe(0);
    },
  );
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
   * 仅在 linked worktree 或 submodule 时再调 `worktree list --porcelain`
   * 取主工作树根。不传 mainRoot 表示该用例不允许出现第二次 spawn
   * (仓库根在 rev-parse 这一步就已确定)。
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

  // git 探测的任何失败都不得阻断记忆: 按 cwd 原样当 scope。
  it.each([
    ['git 不存在 (ENOENT)', () => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })],
    ['非 git 目录 (exit 128)', () => Object.assign(new Error('not a git repository'), { code: 128 })],
    ['探测超时', () => Object.assign(new Error('timed out'), { killed: true })],
  ] as const)('%s → 原样返回', async (_label, makeErr) => {
    expect(
      await resolveMemoryScopeKey('/fake/dir/sub', null, { execGit: failingProbe(makeErr) }),
    ).toBe('/fake/dir/sub');
  });

  // 普通 clone 与 `git clone --separate-git-dir` 的 checkout 都是 gitdir == common-dir
  // 且无 superproject: 仓库根就是 toplevel, 子目录不再各有一份。不得再问
  // `git worktree list` (probeFor 不传 mainRoot 即断言这一点): separate-git-dir 不写
  // core.worktree, git 会把 gitdir 的父目录报成主工作树 (Codex review on #2399)。
  // 期望值按调用方的写法: 根本身原样返回, 子目录是它上溯到根的那一段
  // (path.normalize 只为 Windows 上的分隔符, POSIX 下就是 '/fake/checkout')。
  it.each([
    ['普通 clone 的根', '/fake/checkout/.git', '/fake/checkout', '/fake/checkout'],
    ['普通 clone 的子目录', '/fake/checkout/.git', '/fake/checkout/apps/a', path.normalize('/fake/checkout')],
    ['separate-git-dir checkout 的子目录', '/some/storage/.git', '/fake/checkout/apps/a', path.normalize('/fake/checkout')],
  ])('%s → 仓库根 (toplevel)', async (_label, gitDir, cwd, expected) => {
    const probe = probeFor('/fake/checkout', gitDir, gitDir);
    expect(await resolveMemoryScopeKey(cwd, null, { execGit: probe })).toBe(expected);
  });

  // submodule 的记忆跟外层项目走: 主仓里的归到主仓根; linked worktree 里的
  // gitdir == common-dir (都是 `<主仓>/.git/worktrees/<wt>/modules/<sub>`), 不能当普通
  // clone 处理, 要先找到外层 worktree 再归到主工作树根 (Codex #2399 P1)。
  // 两行在 POSIX 下都是 '/main'; 主仓内的沿用调用方写法, worktree 内的是 git 报的
  // 主工作树路径 (Windows 上后者带盘符)。
  it.each([
    ['主仓内 submodule', '/main/mod', '/main/.git/modules/mod', '/main', path.normalize('/main')],
    ['linked worktree 内 submodule', '/wt/mod', '/main/.git/worktrees/wt/modules/mod', '/wt', path.resolve('/main')],
  ])('%s → 外层项目的主工作树根', async (_label, cwd, gitDir, superproject, expected) => {
    const probe = probeFor(cwd, gitDir, gitDir, '/main', superproject);
    expect(await resolveMemoryScopeKey(cwd, null, { execGit: probe })).toBe(expected);
  });

  it('linked worktree 内二级 submodule 沿 superproject 链归到最外层项目的主工作树根 (Codex #2399 P1)', async () => {
    const abs = (p: string) => path.resolve(p);
    const inner = abs('/wt/mod/inner');
    const parentMod = abs('/wt/mod');
    const wt = abs('/wt');
    const main = abs('/main');
    const byCwd: Record<string, { toplevel: string; gitDir: string; commonDir: string; superproject: string }> = {
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
    // 只在最外层 worktree 上回答 `worktree list`: 在中间那层 submodule 上问,
    // 真实 git 会把 `.git` 元数据目录报成唯一 worktree。
    const probe: GitProbe = async (args, cwd) => {
      if (args.includes('worktree')) {
        if (path.normalize(cwd) !== wt) throw new Error(`worktree list asked at ${cwd}`);
        return `worktree ${main}\n`;
      }
      const rec = byCwd[path.normalize(cwd)] ?? byCwd[cwd];
      if (!rec) throw new Error(`unexpected cwd ${cwd}`);
      return `${rec.toplevel}\n${rec.gitDir}\n${rec.commonDir}\n${rec.superproject}\n`;
    };
    expect(await resolveMemoryScopeKey(inner, null, { execGit: probe })).toBe(main);
  });

  // linked worktree 找不到主工作树可归时 (bare repo 的 worktree: common-dir 是
  // `<name>.git`, 根本没有主工作树; 或 `worktree list` 没给出记录), 用这个 worktree
  // 自己的根, 子目录同样不再各有一份。
  it.each([
    ['bare repo 的 linked worktree', '/fake/repo.git/worktrees/x', '/fake/repo.git', undefined],
    ['worktree list 取不到主工作树', '/main/.git/worktrees/w', '/main/.git', ''],
  ])('%s → 该 worktree 自己的根', async (_label, gitDir, commonDir, worktreeList) => {
    const probe: GitProbe = async (args) => {
      if (args.includes('worktree')) {
        if (worktreeList === undefined) throw new Error('worktree list should not be spawned');
        return `${worktreeList}\n`;
      }
      return `/fake/wt\n${gitDir}\n${commonDir}\n`;
    };
    expect(await resolveMemoryScopeKey('/fake/wt/apps/a', null, { execGit: probe })).toBe(
      path.normalize('/fake/wt'),
    );
  });

  it('主仓本身是 separate-git-dir 布局: linked worktree 归到真实主 checkout 的根', async () => {
    // common-dir 是 git 存储目录 (/storage/.git), dirname 不是工作树;
    // 主工作树根必须来自 `worktree list --porcelain` 第一条 (Codex review 第二轮)。
    const probe = probeFor(
      '/fake/wt',
      '/storage/.git/worktrees/w',
      '/storage/.git',
      '/real/checkout',
    );
    expect(await resolveMemoryScopeKey('/fake/wt/apps/a', null, { execGit: probe })).toBe(
      path.resolve('/real/checkout'),
    );
  });

  // git 报的是物理路径。调用方经符号链接进入仓库时 (macOS `/tmp` → `/private/tmp`),
  // 仓库根要沿用调用方的写法: 换成 git 的写法等于给同一个仓库换了 scope key,
  // 升级前按 cwd 原样记下的记忆就读不到了。
  it(
    '经符号链接进入仓库: 仓库根沿用调用方的路径写法',
    async () => {
      const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-link-')));
      try {
        const physicalRepo = path.join(tmp, 'physical', 'repo');
        await fs.mkdir(path.join(physicalRepo, 'apps', 'a'), { recursive: true });
        // 'junction': Windows 上不需要管理员权限就能建目录链接; POSIX 忽略这个参数。
        await fs.symlink(path.join(tmp, 'physical'), path.join(tmp, 'link'), 'junction');
        const gitDir = path.join(physicalRepo, '.git');
        const probe = probeFor(physicalRepo, gitDir, gitDir);
        expect(
          await resolveMemoryScopeKey(path.join(tmp, 'link', 'repo', 'apps', 'a'), null, {
            execGit: probe,
          }),
        ).toBe(path.join(tmp, 'link', 'repo'));
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it('cwd 与 git 报的仓库根对不上 (物理路径也对不上) → 用 git 报的仓库根', async () => {
    // 无法按调用方的写法上溯时不猜: 仓库身份以 git 的回答为准。
    const probe = probeFor('/totally/other', '/totally/other/.git', '/totally/other/.git');
    expect(await resolveMemoryScopeKey('/fake/escape', null, { execGit: probe })).toBe(
      path.resolve('/totally/other'),
    );
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
    expect(first).toBe(path.normalize(abs('/repo')));
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
      expect(key).toBe('C:\\repo');
    },
  );
});

/*
 * 测试价值
 * - 生产入口与可观察结果：resolveMemoryScopeKey（agent 启动与 memory 工具都 await 它）在 Windows
 *   上 git 探测超时后必须有界返回，回落为 cwd 原样。
 * - Bug／规则依据：PR #10043 review P1：taskkill 成功但树里有进程漏杀、仍占着输出管道时，
 *   execFile 回调永不触发，探测永久挂起；模块契约「宁可回落也不卡 spawn」。
 * - 现有覆盖缺口：其余用例注入 execGit，绕过真实的 Windows 执行与超时路径。
 * - 最小失败输入：Windows、目录带 .git、git 永不结束且管道不关、taskkill 报成功。
 * - tier：unit（fake timers + 替换 execFile，无真实进程与等待）；Windows 真实杀树另见 PR 手工验证。
 * - 实测耗时：整个文件约 1 秒。
 */
describe('resolveMemoryScopeKey — Windows 探测超时', () => {
  it('taskkill 后管道仍被占住时也有界回落为 cwd', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-timeout-'));
    await fs.mkdir(path.join(dir, '.git'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let gitStarted = false;
    childProcess.execFile = (file, _args, _options, callback) => {
      if (file === 'taskkill') {
        queueMicrotask(() => (callback as (error: Error | null) => void)(null));
        return {};
      }
      gitStarted = true;
      // A git whose pipes stay open: execFile's own callback never comes.
      return { pid: 4242, exitCode: null, stdout: { destroy() {} }, stderr: { destroy() {} }, kill() {} };
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      let key: string | undefined;
      void resolveMemoryScopeKey(dir).then((value) => { key = value; });
      await vi.waitFor(() => expect(gitStarted).toBe(true));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(key).toBe(dir);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.useRealTimers();
      childProcess.execFile = null;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// 默认 unit tier 唯一一条真实 Git smoke (§3.1): 端到端打通「真实 git 探测 +
// 归到主工作树根」主路径。组合矩阵见 scope-resolver.git-integration.test.ts。
describe.skipIf(!gitAvailable())('resolveMemoryScopeKey — 真实 Git smoke', () => {
  let tmpRoot: string | undefined;
  let repoRoot: string;
  let sub: string;

  // 建仓与清理使用独立的 hook 预算,不占用真实探测断言的 5 秒时限。
  beforeAll(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-')));
    repoRoot = path.join(tmpRoot, 'repo');
    const wt = path.join(tmpRoot, 'wt');
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    await fs.mkdir(repoRoot, { recursive: true });
    git(['init'], repoRoot);
    git([
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=scope-resolver-test',
      'commit', '--allow-empty', '-m', 'init',
    ], repoRoot);
    git(['worktree', 'add', '-b', 'wt-branch', wt], repoRoot);
    sub = path.join(wt, 'apps', 'a');
    await fs.mkdir(sub, { recursive: true });
  });

  afterAll(async () => {
    if (!tmpRoot) return;
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
    }
  });

  it('linked worktree 子目录 cwd → 主工作树根', async () => {
    expect(await resolveMemoryScopeKey(sub)).toBe(repoRoot);
  });

  it('仓库根带结尾分隔符 → 与从子目录解析出的是同一把钥匙', async () => {
    // 否则 `/repo/` 和 `/repo` 落到两个目录, 同一仓库的记忆被拆开。
    expect(await resolveMemoryScopeKey(`${repoRoot}${path.sep}`)).toBe(repoRoot);
  });

  it('仓库根后面跟着大量连续分隔符: 去干净, 仍是同一把钥匙', async () => {
    // 去掉结尾分隔符改成了逐字符回退 (原来的正则被 CodeQL 判为多项式时间); 行为必须不变。
    expect(await resolveMemoryScopeKey(`${repoRoot}${path.sep.repeat(20_000)}`)).toBe(repoRoot);
  });
});
