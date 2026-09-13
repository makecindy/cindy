/**
 * scope-resolver.ts — resolveMemoryScopeKey: Maker Memory scope key 的 async
 * 归一化入口 (#2379 问题一)。
 *
 * 背景: buildMemoryScopeKey (storage.ts) 是纯同步函数, 本地会话原样透传 workdir
 * 绝对路径。git linked worktree 的 cwd ≠ 主仓路径 → 同一仓库被拆成多个独立
 * Store, worktree 会话 memory_search 恒 0 命中 (实测主仓分片 80 条记录,
 * worktree 分片是空库基线)。
 *
 * 本模块只做一件事: 本地会话取 scope key 前先做 worktree 归一化 ——
 *   linked worktree 的 cwd → `主仓根 + cwd 相对 worktree 根的子路径`
 *   例: /repo/.cindy-worktrees/feat-x/apps/a → /repo/apps/a
 * 即保留「按 cwd 隔离」的既有语义 (子目录仍是独立 scope), 只把 worktree 根
 * 替换回主仓根。「整个仓库共用一份 memory」是 scope 语义变更, 明确不在
 * 本模块做 (#2379 评论收敛)。
 *
 * 分工:
 *  - buildMemoryScopeKey (同步): SSH 复合键规则 + 本地原样透传的既有契约, 不变。
 *  - resolveMemoryScopeKey (async, 本模块): 所有 getStore 调用方的统一入口。
 *    SSH 直接委托 buildMemoryScopeKey (不在控制端解析远端 git); 本地先归一化。
 *
 * 回落 (一律返回 cwd 原样, 与既有行为完全一致): 非 git 目录 / git 不可用 /
 * 探测超时 / bare repo / 非 linked-worktree 布局 (普通 clone /
 * --separate-git-dir checkout, gitdir == common-dir 且无 superproject) /
 * 非常规 common-dir 布局 / cwd 不在 toplevel 下。
 * 特例: linked worktree 内初始化过的 submodule 的 gitdir == common-dir
 * (都是 `<主仓>/.git/worktrees/<wt>/modules/<sub>`), 不能当普通 clone 回落;
 * `--show-superproject-working-tree` 只给直接父仓库, 二级 submodule 的父是
 * 另一层 submodule 而不是 worktree — 必须沿 superproject 链走到最外层
 * (linked worktree 或主仓) 再归一, 否则 `git worktree list` 会把 `.git`
 * 元数据目录报成唯一 worktree (Codex #2399 P1 / #2519 3974808633)。
 * 非仓库目录由 `.git` 标记上溯预检直接短路, 连 git 进程都不 spawn
 * (hasGitMarkerUpward, 与 rev-parse 上溯语义一致)。
 *
 * 缓存: lizi-mcps withStore 在每次 memory 工具调用都经本函数, 不能每次 spawn
 * git 子进程 — 进程内 Map 缓存, in-flight promise 去重。成功的 git 归一化
 * (含「探测成功但无需映射」) sticky, 无 TTL: 活跃会话不得在 60s 后因探测
 * 超时/失败从 canonical 漂回 worktree 路径 (Codex #2519 3968440903)。
 * 失败/非仓库回落仍用 TTL, 以便目录稍后变成仓库时恢复。
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { buildMemoryScopeKey } from './storage.js';

/** git 探测抽象: 跑一条 git 命令, resolve stdout。失败 (非 git 目录/超时/无 git) reject。 */
export type GitProbe = (args: string[], cwd: string) => Promise<string>;

export interface ResolveMemoryScopeKeyDeps {
  /**
   * 测试注入: 替代真实 git 调用 (fake 驱动失败/超时/缓存断言)。
   * 注入 execGit 时跳过 .git 标记预检 — 调用方显式接管探测, 预检无意义。
   */
  execGit?: GitProbe;
  /** 测试注入: 时钟 (TTL 过期路径)。 */
  now?: () => number;
}

/** 单次 git 探测超时。会话启动路径, 宁可回落也不卡 spawn。 */
const GIT_PROBE_TIMEOUT_MS = 3_000;
/** 缓存 TTL (正/负结果一致)。目录身份中途变化是极端场景, 60s 收敛足够。 */
const CACHE_TTL_MS = 60_000;

const execFileAsync = promisify(execFile);

/**
 * 预检: cwd 或任一祖先目录存在 `.git` 才值得 spawn git。非仓库目录 (dialogue
 * 一次性目录、临时 cwd) 直接跳过 — 与 git rev-parse 的上溯查找语义一致, 但把
 * 两次进程 spawn 换成几次 stat。对 Windows 还有一层必要收益: 短命子进程引用
 * 临时目录会跟 teardown 删目录撞出 EPERM。
 */
async function hasGitMarkerUpward(cwd: string): Promise<boolean> {
  let dir = cwd;
  for (;;) {
    try {
      await fs.access(path.join(dir, '.git'));
      return true;
    } catch {
      /* 不在这一层, 继续上溯 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

async function defaultExecGit(args: string[], cwd: string): Promise<string> {
  // 用 `git -C <dir>` 而不是 child 的 cwd 选项: Windows 上子进程的 CWD 会锁住
  // 该目录, 会话用临时 cwd 的测试/短命场景在 teardown 删目录时 EPERM。
  // 相对路径输出 (--git-common-dir) 相对 -C 目录解析, 与 cwd 选项语义一致。
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

interface CacheEntry {
  value: Promise<string>;
  expiresAt: number;
}

const scopeKeyCache = new Map<string, CacheEntry>();

/** 测试专用: 清空进程内缓存。生产代码不应调用。 */
export function __clearMemoryScopeKeyCacheForTests(): void {
  scopeKeyCache.clear();
}

/**
 * 取 scope key 的统一入口 (async)。所有 getStore 调用方 (agent 启动注入 /
 * MCP withStore / manager 兜底) 必须经本函数, 不得各自拼 key 或自行探测 git。
 */
export async function resolveMemoryScopeKey(
  workingDir: string,
  remoteHostId?: string | null,
  deps?: ResolveMemoryScopeKeyDeps,
): Promise<string> {
  // SSH remote: 复合键规则不变 (单射性质经过 review, 见 storage.ts),
  // 远端路径是远端机器上的字符串, 控制端不解析远端 git。
  if (remoteHostId) return buildMemoryScopeKey(workingDir, remoteHostId);
  if (!workingDir) return workingDir;

  const execGit = deps?.execGit;
  const now = deps?.now ?? (() => Date.now());
  // Windows: 大小写不敏感 + 正反斜杠/UNC 形态先收成稳定 key, 避免同一目录打两轮 git。
  const cacheKey =
    process.platform === 'win32'
      ? normalizeWindowsLocalScopeKey(workingDir).toLowerCase()
      : workingDir;
  const hit = scopeKeyCache.get(cacheKey);
  if (hit && hit.expiresAt > now()) return hit.value;

  const entry: CacheEntry = {
    value: Promise.resolve(finalizeLocalScopeKey(workingDir)),
    expiresAt: now() + CACHE_TTL_MS,
  };
  entry.value = (async () => {
    // 非仓库目录预检 (默认探测路径): 没有 .git 标记时 git rev-parse 必然失败,
    // 直接回落, 省掉一次进程 spawn (也避开 Windows 临时目录的 EPERM 竞争)。
    // 注入了 execGit 的调用方显式接管探测, 跳过预检。
    if (!execGit && !(await hasGitMarkerUpward(path.normalize(workingDir)).catch(() => true))) {
      return finalizeLocalScopeKey(workingDir);
    }
    try {
      // 探测成功 (含无需映射) 即钉死: TTL 后再探测失败不得把已绑定的
      // canonical 漂回 raw worktree (Codex #2519 3968440903)。
      const resolved = await canonicalizeLocalWorkdir(
        workingDir,
        execGit ?? defaultExecGit,
      );
      entry.expiresAt = Number.POSITIVE_INFINITY;
      return finalizeLocalScopeKey(resolved);
    } catch {
      // 失败回落 cwd 原样 — 归一化是纯增强, 绝不让 git 探测故障阻断 memory。
      // 负结果保留 TTL, 不 sticky。
      return finalizeLocalScopeKey(workingDir);
    }
  })();
  scopeKeyCache.set(cacheKey, entry);
  return entry.value;
}

/**
 * linked worktree cwd → `主仓根 + cwd 相对 worktree 根的子路径`。
 * 探测方式与 desktop WorktreeManager 同模式: rev-parse + path.resolve
 * 解析相对输出 (兼容不支持 --path-format 的旧 git)。单次 rev-parse 拿
 * toplevel / git-dir / git-common-dir / superproject 四个值 (输出顺序与
 * 参数一致; 无 superproject 时第四行为空); 确认是 linked worktree 或
 * worktree 内 submodule 后再用一次 `worktree list --porcelain` 取主仓根。
 * 失败抛错由调用方回落。
 */
async function canonicalizeLocalWorkdir(workingDir: string, execGit: GitProbe): Promise<string> {
  const cwd = path.normalize(workingDir);
  const out = await execGit(
    [
      'rev-parse',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      '--show-superproject-working-tree',
    ],
    cwd,
  );
  const [toplevelRaw, gitDirRaw, commonDirRaw, superRaw] = out.split('\n');
  const toplevel = resolveGitDirOutput(toplevelRaw ?? '', cwd);
  const gitDir = resolveGitDirOutput(gitDirRaw ?? '', cwd);
  const commonDir = resolveGitDirOutput(commonDirRaw ?? '', cwd);
  const directSuper = resolveGitDirOutput(superRaw ?? '', cwd);
  if (!toplevel || !gitDir || !commonDir) return workingDir;

  // 判定链 (Codex #2399 P1 / #2519 3974808633, linked-worktree submodule):
  //  1. gitdir ≠ common-dir → 真 linked worktree, 归一到主仓根 + 相对路径。
  //  2. gitdir == common-dir 且有 superproject → cwd 是 submodule。
  //     主仓内 submodule 的 superproject == 主仓根, 原样返回 (与 round-1 契约一致)。
  //     linked worktree 内 submodule 的 gitdir == common-dir (都是
  //     `<主仓>/.git/worktrees/<wt>/modules/<sub>`), 不能当普通 clone 回落;
  //     把**最外层** superproject (walk 链, 不是直接父) 当 mapping 根再走
  //     同一套主仓映射, 得到 `/main/<nested-rel>` 而不是 `.git` 元数据目录。
  //  3. gitdir == common-dir 且无 superproject → 普通 clone /
  //     --separate-git-dir checkout, 原样返回。separate-git-dir 的 common-dir
  //     basename 恰好也是 `.git`, 不先排除会把主仓根错误推导到 git 存储目录
  //     (Codex review on #2399)。
  const outermostSuper = directSuper
    ? await walkOutermostSuperproject(directSuper, execGit)
    : null;
  if (samePath(gitDir, commonDir)) {
    if (!outermostSuper) return workingDir;
  } else if (path.basename(commonDir) !== '.git') {
    // bare repo 的 linked worktree (common-dir 是 `<name>.git`) 等非常规布局
    // 无法可靠推断主仓根, 回落原样。submodule 走上面 superproject 分支,
    // 不看这一条 (其 gitdir == common-dir)。
    return workingDir;
  }

  const mappingRoot = outermostSuper ?? toplevel;

  // 主仓根不能从 common-dir 推导: 主 checkout 本身用 --separate-git-dir 建
  // 时 common-dir 是 git 存储目录, dirname 不一定是工作树 (Codex review on
  // #2399 第二轮)。统一用 `git worktree list --porcelain` 第一条记录 — git
  // 保证主工作树排第一; 布局带 core.worktree 指针时取到真实主 checkout。
  //
  // 已知限制: `git clone --separate-git-dir` 不写 core.worktree, git 自身
  // 也无法从 gitdir 反推真实 checkout (`git worktree list` 直接把 gitdir
  // 父目录报为主工作树, 连从真实 checkout 里跑都一样)。这种布局下本函数
  // 跟随 git 的 canonical 答案; 主 checkout 会话按 round-1 契约不归一化,
  // 即该极端布局下主 checkout 与 worktree 的 memory 不共享 (与 PR 前行为
  // 一致, 不回归)。
  const mainRoot = await resolveMainWorktreeRoot(mappingRoot, execGit);
  if (!mainRoot) return workingDir;

  // 防御: 映射根即主仓根时无需归一化 (主仓内 cwd / 主仓内 submodule),
  // 原样返回, 保持「本地原样返回」契约。
  if (samePath(mappingRoot, mainRoot)) return workingDir;

  // linked worktree (含其内 submodule): 子路径映射回主仓根下
  // (该路径在主仓可以不存在 — scope key 只是身份字符串, 落盘目录名经
  // memoryScopeDirName 派生)。
  const rel = path.relative(mappingRoot, cwd);
  if (rel === '') return mainRoot;
  // cwd 不在映射根下 (symlink/大小写风格不一致等) — 不猜, 回落。
  // 只拒绝真正的父目录相对路径 (`..` / `../…`); `..config` / `...` 是合法
  // 子目录名, `rel.startsWith('..')` 会误判逃逸 (Codex #2519 3974018445)。
  if (isEscapedRelative(rel)) return workingDir;
  return path.join(mainRoot, rel);
}

/** path.relative 结果是否表示 cwd 已逃出 mappingRoot。 */
function isEscapedRelative(rel: string): boolean {
  if (path.isAbsolute(rel)) return true;
  const norm = rel.replace(/\\/g, '/');
  return norm === '..' || norm.startsWith('../');
}

function finalizeLocalScopeKey(key: string): string {
  if (process.platform === 'win32') return normalizeWindowsLocalScopeKey(key);
  return key;
}

/**
 * Windows 本地 scope key 的稳定形态 (Codex review on #2519 第八/十九轮)。
 *
 * MakerMemoryManager 用 raw 字符串当 Map key, memoryScopeDirName 却把
 * `\` 与 `/` 收成同一磁盘目录。主 checkout (Desktop 正斜杠 / 正斜杠 UNC)
 * 与 worktree (`path.join` 反斜杠 / `\\server\share`) 必须收成同一 key。
 *
 * 规则:
 *  - 分隔符一律 `/`; UNC 保留 `//server/share` 双斜杠前缀, 不塌成单斜杠
 *  - `\\?\C:\...` / `\\?\UNC\` 长路径前缀剥掉后再规范化 (否则 sanitize 目录不同);
 *    `\\?\Volume{GUID}\...` / `\\?\GLOBALROOT\...` 等非 DOS 设备路径保留 `//?/` 根 (Codex 3974674292)
 *  - 折叠重复斜杠; 去掉尾随斜杠; 根盘保持 `C:/` (保留盘符大小写)
 *  - **不**把路径段改成小写: sanitizeWorkdir 区分 `C--Users` 与 `c--users`,
 *    全量小写会把已有分片拆开, 需独立迁移; cache/samePath 已大小写不敏感
 *  - 相对盘符 `C:foo` / 裸 `C:` 不抬成 `C:/foo` / `C:/` (cwd 相关, 不稳定;
 *    Codex 3972854297: `C:` 是 drive-relative, 不等于 `C:/`)
 *  - ssh: / bot: 复合键不碰
 */
export function normalizeWindowsLocalScopeKey(input: string): string {
  if (!input) return input;
  if (input.startsWith('ssh:') || input.startsWith('bot:')) return input;

  let s = input.replace(/\//g, '\\');

  // `\\?\UNC\server\share` / `\\?\C:\...` — 用 slice 避开正则反斜杠计数。
  // 只剥盘符绝对与 UNC; Volume/GLOBALROOT 等设备命名空间保留前缀
  // (Codex #2519 3974674292), 否则会变成相对 `Volume{GUID}/repo`。
  const longUnc = '\\\\?\\UNC\\';
  const longDos = '\\\\?\\';
  if (s.length >= longUnc.length && s.slice(0, longUnc.length).toLowerCase() === longUnc.toLowerCase()) {
    s = '\\\\' + s.slice(longUnc.length);
  } else if (s.startsWith(longDos)) {
    const rest = s.slice(longDos.length);
    if (/^[A-Za-z]:[\\/]/.test(rest)) {
      s = rest;
    }
  }

  const isUnc = s.startsWith('\\\\');
  s = s.replace(/\\/g, '/');

  if (isUnc) {
    s = '//' + s.slice(2).replace(/\/+/g, '/');
    s = s.replace(/\/+$/, '');
    if (s === '' || s === '/') return '//';
    return s;
  }

  s = s.replace(/\/+/g, '/');
  const drive = s.match(/^([A-Za-z]:)(.*)$/);
  if (drive) {
    const letter = drive[1];
    const rest = drive[2];
    if (!rest.startsWith('/')) {
      // 裸 `C:` 与 `C:foo` 都是 drive-relative, 不抬成根盘 (Codex 3972854297)
      return `${letter}${rest}`;
    }
    const trimmed = rest.replace(/\/+$/, '');
    if (trimmed === '') return `${letter}/`;
    return `${letter}${trimmed}`;
  }

  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/** Desktop / Windows 形态路径 (盘符、UNC、`\\?\` 长路径), 供 migrate 跨平台复用。 */
export function looksLikeWindowsLocalPath(p: string): boolean {
  if (/^[A-Za-z]:/.test(p)) return true;
  const slashes = p.replace(/\//g, '\\');
  return slashes.startsWith('\\\\');
}

/** git rev-parse 输出 → 绝对路径。空输出返 null (调用方回落)。 */
function resolveGitDirOutput(raw: string, cwd: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return path.normalize(path.resolve(cwd, trimmed));
}

/**
 * `git worktree list --porcelain` 第一条 `worktree ` 记录 = 主工作树路径
 * (git 保证主工作树排第一)。取不到返 null (调用方回落)。
 */
async function resolveMainWorktreeRoot(cwd: string, execGit: GitProbe): Promise<string | null> {
  const out = await execGit(['worktree', 'list', '--porcelain'], cwd);
  const line = out.split('\n').find((l) => l.startsWith('worktree '));
  if (!line) return null;
  return resolveGitDirOutput(line.slice('worktree '.length), cwd);
}

function samePath(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return (
      normalizeWindowsLocalScopeKey(a).toLowerCase() ===
      normalizeWindowsLocalScopeKey(b).toLowerCase()
    );
  }
  return a === b;
}

/**
 * `--show-superproject-working-tree` 只给直接父仓库。二级 submodule 的父是
 * 另一层 submodule, 在那一层跑 `git worktree list` 会把
 * `<main>/.git/worktrees/<wt>/modules/<parent>` 报成唯一 worktree, 把
 * scope 映射进 .git 元数据目录 (Codex #2399 P1)。沿链走到没有 superproject
 * 的最外层 (linked worktree 或主仓) 再交给 resolveMainWorktreeRoot。
 */
async function walkOutermostSuperproject(start: string, execGit: GitProbe): Promise<string> {
  let current = start;
  const seen = new Set<string>();
  for (let i = 0; i < 16; i += 1) {
    const key =
      process.platform === 'win32'
        ? normalizeWindowsLocalScopeKey(current).toLowerCase()
        : current;
    if (seen.has(key)) return current;
    seen.add(key);
    // 与 canonicalize 同一条 4 行 rev-parse, 让既有 cwd-agnostic fake probe
    // 仍返回 superproject 在第四行; 单字段 --show-superproject-working-tree
    // 会被 probeFor 的第一行 toplevel 误当成父仓。
    const out = await execGit(
      [
        'rev-parse',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
        '--show-superproject-working-tree',
      ],
      current,
    ).catch(() => '');
    const parent = resolveGitDirOutput(out.split('\n')[3] ?? '', current);
    if (!parent || samePath(parent, current)) return current;
    current = parent;
  }
  return current;
}
