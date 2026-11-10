/**
 * 项目记忆按仓库共用一份 — 真实 Git 组合矩阵。
 *
 *  - resolveMemoryScopeKey: 仓库里任何 cwd (子目录 / linked worktree / submodule)
 *    归到主工作树根 (#2379 起 worktree 根归主仓, 2026-11 起子目录也归仓库根);
 *  - MakerMemoryManager: 旧版本按 cwd 记下的子目录记忆, 在首次打开仓库根时并入
 *    (并入靠真实 git 判定「这个目录今天是否仍属于本仓库」, 没有可注入的探测口)。
 *
 * 属于 git-integration tier (`pnpm test:git-integration`), 不在默认 unit
 * tier 运行 (engineering-conventions §3.1: 每个用例都要建临时仓库 / linked
 * worktree / separate-git-dir clone, 反复 spawn git 子进程)。默认层的
 * fake probe 覆盖与唯一 smoke 见 scope-resolver.test.ts。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import {
  __clearMemoryScopeKeyCacheForTests,
  resolveMemoryScopeKey,
} from './scope-resolver.js';
import { memoryScopeDirName } from './storage.js';
import type { Logger } from '../interfaces/logger.js';

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

  // 同一仓库里从哪儿开任务都拿到同一份记忆: 主仓与 linked worktree、根与子目录、
  // 只在 worktree 里存在的目录, 全部归到主工作树根。旧规则下子目录各有一份
  // (`主仓根 + 相对子路径`), 这些输入曾分属四条用例; 现在结果相同, 合成一张表。
  it('仓库内任何 cwd (主仓 / linked worktree, 根 / 子目录) → 主工作树根', async () => {
    const f = await makeFixture();
    try {
      const cwds: Array<[label: string, cwd: string]> = [
        ['主仓根', f.repoRoot],
        ['主仓子目录', path.join(f.repoRoot, 'apps', 'b')],
        ['linked worktree 根', f.wt1],
        ['linked worktree 子目录', path.join(f.wt1, 'apps', 'a')],
        ['只在 worktree 里存在的子目录', path.join(f.wt1, 'apps', 'only-in-wt')],
        ['另一个 linked worktree 的子目录', path.join(f.wt2, 'apps', 'a')],
      ];
      for (const [label, cwd] of cwds) {
        expect(await resolveMemoryScopeKey(cwd), label).toBe(f.repoRoot);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('git clone --separate-git-dir 的 checkout: 仓库根是它自己的 toplevel (Codex review 第一轮场景)', async () => {
    const f = await makeFixture();
    try {
      const storage = path.join(f.tmpRoot, 'storage', '.git');
      const checkout = path.join(f.tmpRoot, 'separate-checkout');
      // git 不会创建 --separate-git-dir 的父目录
      await fs.mkdir(path.dirname(storage), { recursive: true });
      f.git(['clone', '--separate-git-dir', storage, f.repoRoot, checkout], f.tmpRoot);
      const sub = path.join(checkout, 'apps', 'a');
      await fs.mkdir(sub, { recursive: true });
      // 不能跟 `git worktree list` 走: 它会把 gitdir 的父目录 (storage/) 报成主工作树。
      expect(await resolveMemoryScopeKey(checkout)).toBe(checkout);
      expect(await resolveMemoryScopeKey(sub)).toBe(checkout);
    } finally {
      await f.cleanup();
    }
  });

  it('主仓是 clone --separate-git-dir (无 core.worktree 指针): linked worktree 跟随 git worktree list 的 canonical 答案 (已知限制)', async () => {
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
      // 所有 linked worktree 共用这一份; 主 checkout 自己用它的 toplevel (上一条)。
      const canonical = path.dirname(storage);
      expect(await resolveMemoryScopeKey(wt3)).toBe(canonical);
      expect(await resolveMemoryScopeKey(sub)).toBe(canonical);
    } finally {
      await f.cleanup();
    }
  });

  it('bare repo 的 linked worktree: 没有主工作树可归, 用该 worktree 自己的根', async () => {
    const f = await makeFixture();
    try {
      const bare = path.join(f.tmpRoot, 'bare.git');
      const bareWt = path.join(f.tmpRoot, 'bare-wt');
      f.git(['clone', '--bare', f.repoRoot, bare], f.tmpRoot);
      f.git(['worktree', 'add', '-b', 'bare-wt-branch', bareWt], bare);
      const sub = path.join(bareWt, 'apps', 'a');
      await fs.mkdir(sub, { recursive: true });
      expect(await resolveMemoryScopeKey(bareWt)).toBe(bareWt);
      expect(await resolveMemoryScopeKey(sub)).toBe(bareWt);
    } finally {
      await f.cleanup();
    }
  });

  it('submodule (主仓内 / linked worktree 内初始化过的) → 外层项目的主工作树根 (Codex #2399 P1)', async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-sub-')));
    const subRepo = path.join(tmpRoot, 'sub');
    const repoRoot = path.join(tmpRoot, 'repo');
    const wt = path.join(tmpRoot, 'wt');
    const git = (args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv) =>
      execFileSync('git', args, {
        cwd,
        stdio: 'ignore',
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
    try {
      await fs.mkdir(subRepo, { recursive: true });
      git(['init'], subRepo);
      git(['config', 'user.email', 'test@example.com'], subRepo);
      git(['config', 'user.name', 'scope-resolver-test'], subRepo);
      await fs.writeFile(path.join(subRepo, 'README'), 'sub\n');
      git(['add', '.'], subRepo);
      git(['commit', '-m', 'sub'], subRepo);

      await fs.mkdir(repoRoot, { recursive: true });
      git(['init'], repoRoot);
      git(['config', 'user.email', 'test@example.com'], repoRoot);
      git(['config', 'user.name', 'scope-resolver-test'], repoRoot);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepo, 'mod'], repoRoot);
      git(['commit', '-m', 'add sub'], repoRoot);
      git(['worktree', 'add', '-b', 'wt-branch', wt], repoRoot);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], wt);

      // submodule 的记忆跟外层项目走, 不再按 `主仓根/mod` 另存一份。
      expect(await resolveMemoryScopeKey(path.join(wt, 'mod'))).toBe(repoRoot);
      expect(await resolveMemoryScopeKey(path.join(repoRoot, 'mod'))).toBe(repoRoot);
    } finally {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
    }
  });

  it('二级 submodule (主仓内 / linked worktree 内) → 最外层项目的主工作树根 (Codex #2399 P1)', async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-resolver-nested-sub-')));
    const innerRepo = path.join(tmpRoot, 'inner');
    const midRepo = path.join(tmpRoot, 'mid');
    const repoRoot = path.join(tmpRoot, 'repo');
    const wt = path.join(tmpRoot, 'wt');
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, {
        cwd,
        stdio: 'ignore',
        env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
      });
    try {
      await fs.mkdir(innerRepo, { recursive: true });
      git(['init'], innerRepo);
      git(['config', 'user.email', 'test@example.com'], innerRepo);
      git(['config', 'user.name', 'scope-resolver-test'], innerRepo);
      await fs.writeFile(path.join(innerRepo, 'README'), 'inner\n');
      git(['add', '.'], innerRepo);
      git(['commit', '-m', 'inner'], innerRepo);

      await fs.mkdir(midRepo, { recursive: true });
      git(['init'], midRepo);
      git(['config', 'user.email', 'test@example.com'], midRepo);
      git(['config', 'user.name', 'scope-resolver-test'], midRepo);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', innerRepo, 'inner'], midRepo);
      git(['commit', '-m', 'add inner'], midRepo);

      await fs.mkdir(repoRoot, { recursive: true });
      git(['init'], repoRoot);
      git(['config', 'user.email', 'test@example.com'], repoRoot);
      git(['config', 'user.name', 'scope-resolver-test'], repoRoot);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', midRepo, 'mod'], repoRoot);
      git(['commit', '-m', 'add mid'], repoRoot);
      git(['worktree', 'add', '-b', 'wt-nested', wt], repoRoot);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], wt);

      // 直接父仓库是另一层 submodule: 必须走到最外层, 不能停在 `.git` 元数据目录。
      expect(await resolveMemoryScopeKey(path.join(wt, 'mod', 'inner'))).toBe(repoRoot);
      expect(await resolveMemoryScopeKey(path.join(repoRoot, 'mod', 'inner'))).toBe(repoRoot);
    } finally {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上 git 只读对象偶发 EPERM — temp 目录交给 OS 清理 */
      }
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

/**
 * 旧子目录记忆并入仓库根 (docs/product-rules/cindy-memory.md §1「项目按仓库归并」)。
 *
 * 入口: `MakerMemoryManager.getStore(<仓库根>)` —— 升级后第一次打开某个仓库的记忆。
 * 保护的规则: 旧版本按 cwd 记在子目录名下的记忆, 升级后不能读不到 (存量数据迁移);
 * 并入不覆盖、不删除来源、不重复; 只并入今天仍解析到本仓库的目录。
 * 为什么在这个 tier: 「是否仍属于本仓库」由真实 git 判定, manager 没有可注入的探测口,
 * 非 git 目录下并入永远不会发生, 默认层测不到正向路径。
 */
describe.skipIf(!gitAvailable())('MakerMemoryManager — 旧子目录记忆并入仓库根 (真实 Git)', () => {
  const noopLogger: Logger = {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
    child: () => noopLogger,
  };
  /** 并入回执的文件名是落盘格式: 改名会让已并入的目录在升级后被再并入一次。 */
  const RECEIPT = '.cindy-memory-merged-v1.json';

  let tmpRoot: string;
  let ownerRoot: string;
  let repo: string;
  let sub: string;
  let nested: string;
  let managers: MakerMemoryManager[];

  /** 一个 manager = 一次应用进程; 并入在每个进程里对每个仓库只扫一次。 */
  function launch(): MakerMemoryManager {
    const manager = new MakerMemoryManager({
      basePath: ownerRoot,
      sqliteFactory: (filePath) => new DatabaseCtor(filePath),
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
    });
    managers.push(manager);
    return manager;
  }

  const legacyDir = (scopeKey: string) =>
    path.join(ownerRoot, 'maker-memory', memoryScopeDirName(scopeKey));
  const note = (name: string, body: string) => ({
    type: 'project' as const, name, title: `title-${name}`, description: `about ${name}`, body,
  });
  const filenames = async (manager: MakerMemoryManager) =>
    (await (await manager.getStore(repo)).list()).map((r) => r.filename);

  beforeEach(async () => {
    managers = [];
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-subscope-merge-')));
    ownerRoot = path.join(tmpRoot, 'owner');
    repo = path.join(tmpRoot, 'repo');
    sub = path.join(repo, 'sub');
    nested = path.join(repo, 'vendor', 'nested');
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    // 仓库里嵌着的另一个独立仓库 (不是 submodule): 它的记忆属于它自己。
    execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });

    // 升级前的落盘状态: 仓库根、子目录、嵌套仓库各按自己的 cwd 存了一份。
    // 先写仓库根 (此时还没有子目录记忆可并), 再写另外两份。
    const before = launch();
    await (await before.getStore(repo)).write(note('note', 'root says A'));
    const subStore = await before.getStore(sub);
    await subStore.write(note('note', 'sub says B'));
    await subStore.write(note('only-sub', 'only in sub'));
    await (await before.getStore(nested)).write(note('nested-only', 'belongs to nested repo'));
    before.dispose();
  });

  afterEach(async () => {
    for (const manager of managers) manager.dispose();
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 上 git 只读对象 / 刚关闭的 fts.db 偶发 EPERM — temp 目录交给 OS 清理 */
    }
  });

  it('首次打开仓库根: 子目录的记忆并入, 同名不同内容换名并入, 来源保留并留下回执', async () => {
    const store = await launch().getStore(repo);

    expect((await store.list()).map((r) => r.filename)).toEqual([
      'project_note.md', 'project_note-2.md', 'project_only-sub.md',
    ]);
    // 同名不同内容: 仓库根原有的不被覆盖, 子目录那条换名并入。
    expect((await store.read('project_note.md')).body.trim()).toBe('root says A');
    expect((await store.read('project_note-2.md')).body.trim()).toBe('sub says B');
    // 并入的条目进了下一次任务要注入的索引, 不只是躺在目录里。
    expect(await store.getIndex()).toContain('[project_only-sub.md]');

    const source = legacyDir(sub);
    expect(existsSync(path.join(source, 'project_note.md'))).toBe(true);
    expect(existsSync(path.join(source, 'project_only-sub.md'))).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(source, RECEIPT), 'utf8'))).toMatchObject({
      mergedInto: repo,
    });
  });

  it('再次打开不产生副本: 有回执时跳过来源; 回执丢失时靠同内容比对', async () => {
    const expected = ['project_note.md', 'project_note-2.md', 'project_only-sub.md'];
    expect(await filenames(launch())).toEqual(expected);
    // 重启应用 (新进程): 回执让来源目录不再被扫。
    expect(await filenames(launch())).toEqual(expected);
    // 回执没写成 (上次并入中断) 时会重扫来源: 已并入的同内容条目不得再多一份。
    await fs.rm(path.join(legacyDir(sub), RECEIPT));
    expect(await filenames(launch())).toEqual(expected);
  });

  it('子目录已不存在: 按最近一层还在的上级目录判断, 仍并入仓库根', async () => {
    // 只在某个已删除的 worktree 里存在过的子目录: 不并入的话这些记忆再没有任务会读到。
    await fs.rm(sub, { recursive: true, force: true });
    expect(await filenames(launch())).toContain('project_only-sub.md');
  });

  it('嵌套的独立仓库不并入: 它今天解析到的是自己, 不是外层仓库', async () => {
    expect(await filenames(launch())).not.toContain('project_nested-only.md');
    expect(existsSync(path.join(legacyDir(nested), RECEIPT))).toBe(false);
    // 它自己的那份原样可读。
    expect(await (await launch().getStore(nested)).list()).toHaveLength(1);
  });
});
