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
 * 探测超时 / bare repo / 非 linked-worktree 布局 (普通 clone / submodule /
 * --separate-git-dir checkout, gitdir == common-dir) / 非常规 common-dir 布局 /
 * cwd 不在 toplevel 下。
 * 非仓库目录由 `.git` 标记上溯预检直接短路, 连 git 进程都不 spawn
 * (hasGitMarkerUpward, 与 rev-parse 上溯语义一致)。
 *
 * 缓存: lizi-mcps withStore 在每次 memory 工具调用都经本函数, 不能每次 spawn
 * git 子进程 — 进程内 Map 缓存 (正/负结果同 TTL, in-flight promise 去重)。
 * TTL 兜底「目录身份在进程生命周期内变化」(目录后变成 worktree 等) 的极端
 * 场景; 归一化本身幂等 (主仓路径再解析返回自身), 缓存不破坏正确性。
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
  // Windows 路径大小写不敏感, 缓存 key 统一小写 (返回值保留原始大小写)。
  const cacheKey = process.platform === 'win32' ? workingDir.toLowerCase() : workingDir;
  const hit = scopeKeyCache.get(cacheKey);
  if (hit && hit.expiresAt > now()) return hit.value;

  const value = (async () => {
    // 非仓库目录预检 (默认探测路径): 没有 .git 标记时 git rev-parse 必然失败,
    // 直接回落, 省掉一次进程 spawn (也避开 Windows 临时目录的 EPERM 竞争)。
    // 注入了 execGit 的调用方显式接管探测, 跳过预检。
    if (!execGit && !(await hasGitMarkerUpward(path.normalize(workingDir)).catch(() => true))) {
      return workingDir;
    }
    // 任何失败都回落 cwd 原样 — 归一化是纯增强, 绝不让 git 探测故障阻断 memory。
    return canonicalizeLocalWorkdir(workingDir, execGit ?? defaultExecGit).catch(() => workingDir);
  })();
  scopeKeyCache.set(cacheKey, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

/**
 * linked worktree cwd → `主仓根 + cwd 相对 worktree 根的子路径`。
 * 探测方式与 desktop WorktreeManager 同模式: rev-parse + path.resolve
 * 解析相对输出 (兼容不支持 --path-format 的旧 git)。单次 rev-parse 拿
 * toplevel / git-dir / git-common-dir 三个值 (输出顺序与参数一致);
 * 确认是 linked worktree 后再用一次 `worktree list --porcelain` 取主仓根。
 * 失败抛错由调用方回落。
 */
async function canonicalizeLocalWorkdir(workingDir: string, execGit: GitProbe): Promise<string> {
  const cwd = path.normalize(workingDir);
  const out = await execGit(
    ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
    cwd,
  );
  const [toplevelRaw, gitDirRaw, commonDirRaw] = out.split('\n');
  const toplevel = resolveGitDirOutput(toplevelRaw ?? '', cwd);
  const gitDir = resolveGitDirOutput(gitDirRaw ?? '', cwd);
  const commonDir = resolveGitDirOutput(commonDirRaw ?? '', cwd);
  if (!toplevel || !gitDir || !commonDir) return workingDir;

  // 只在真正的 linked worktree 上归一化: gitdir ≠ common-dir
  // (linked worktree 的 gitdir 是 `<主仓>/.git/worktrees/<name>`)。
  // 普通 clone / submodule / `git clone --separate-git-dir` 的 gitdir 与
  // common-dir 相同 — separate-git-dir 的 common-dir basename 恰好也是
  // `.git`, 不先排除会把主仓根错误推导到 git 存储目录, 静默打开无关 Store
  // (Codex review on #2399)。
  if (samePath(gitDir, commonDir)) return workingDir;

  // bare repo 的 linked worktree (common-dir 是 `<name>.git`) 等非常规布局
  // 无法可靠推断主仓根, 回落原样。
  if (path.basename(commonDir) !== '.git') return workingDir;

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
  const mainRoot = await resolveMainWorktreeRoot(cwd, execGit);
  if (!mainRoot) return workingDir;

  // 防御: toplevel 即主仓根时无需归一化 (gitdir ≠ common-dir 的异常布局),
  // 原样返回, 保持「本地原样返回」契约。
  if (samePath(toplevel, mainRoot)) return workingDir;

  // linked worktree: 子路径映射回主仓根下 (该路径在主仓可以不存在 —
  // scope key 只是身份字符串, 落盘目录名经 memoryScopeDirName 派生)。
  const rel = path.relative(toplevel, cwd);
  if (rel === '') return matchSeparatorStyle(workingDir, mainRoot);
  // cwd 不在 toplevel 下 (symlink/大小写风格不一致等) — 不猜, 回落。
  if (rel.startsWith('..') || path.isAbsolute(rel)) return workingDir;
  const mapped = path.join(mainRoot, rel);
  // Windows: Desktop 存正斜杠路径 (C:/repo), 但 path.normalize/join 在
  // Windows 上产反斜杠 (C:\repo)。两者 sanitize 到同一磁盘目录, 而
  // MakerMemoryManager 按 raw scope key 缓存 Store — 主 checkout 会话
  // (正斜杠 key) 与 worktree 会话 (反斜杠 key) 会开两个实例指向同一
  // SQLite/索引, 一侧写入后另一侧 MEMORY.md 缓存过期 (Codex review on
  // #2519 第八轮)。返回与输入同拼写风格的结果, 保证同一目录只一个 key。
  return matchSeparatorStyle(workingDir, mapped);
}

/** 让 result 的分隔符风格与参考路径 (workingDir) 一致。Windows 专用。 */
function matchSeparatorStyle(reference: string, result: string): string {
  if (process.platform !== 'win32') return result;
  // 仅当参考路径是 Windows 盘符正斜杠形态 (C:/repo — Desktop 存储的归一化
  // 拼写) 时把结果转正斜杠, 与主 checkout 会话的 scope key 拼写一致;
  // POSIX 风格路径 (/fake/...) 与反斜杠输入保持 path.join 默认行为。
  if (/^[A-Za-z]:\//.test(reference)) return result.replace(/\\/g, '/');
  return result;
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
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
