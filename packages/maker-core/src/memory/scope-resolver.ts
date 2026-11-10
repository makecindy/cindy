/**
 * scope-resolver.ts — resolveMemoryScopeKey: Maker Memory scope key 的 async
 * 归一化入口。
 *
 * 项目记忆按**仓库**共用一份: 本地会话的 cwd 归到它所在仓库的主工作树根。
 *   /repo/apps/a                          → /repo   (子目录)
 *   /repo/.cindy-worktrees/feat-x/apps/a  → /repo   (linked worktree)
 *   /repo/vendor/sub                      → /repo   (submodule 跟外层项目)
 * 不在 git 仓库里的目录仍按 cwd 原样。
 *
 * 历史: buildMemoryScopeKey (storage.ts) 原样透传 workdir, linked worktree 的
 * cwd ≠ 主仓路径 → 同一仓库被拆成多个 Store (#2379 先把 worktree 根换回主仓根,
 * 子目录仍各自隔离)。2026-11 起子目录也归到仓库根: 在同一仓库的不同目录开任务
 * 应当拿到同一份记忆。旧的子目录记忆由 manager 在打开仓库根 store 时并入
 * (见 manager.ts mergeLegacySubScopes)。
 *
 * 分工:
 *  - buildMemoryScopeKey (同步): SSH 复合键规则 + 本地原样透传的既有契约, 不变。
 *  - resolveMemoryScopeKey (async, 本模块): 所有 getStore 调用方的统一入口。
 *    SSH 直接委托 buildMemoryScopeKey (不在控制端解析远端 git); 本地先归一化。
 *
 * 回落 (一律返回 cwd 原样): 非 git 目录 / git 不可用 / 探测超时 / bare repo 本体。
 * 非仓库目录由 `.git` 标记上溯预检直接短路, 连 git 进程都不 spawn
 * (hasGitMarkerUpward, 与 rev-parse 上溯语义一致)。
 *
 * 缓存: lizi-mcps withStore 在每次 memory 工具调用都经本函数, 不能每次 spawn
 * git 子进程 — 进程内 Map 缓存 (正/负结果同 TTL, in-flight promise 去重)。
 * TTL 兜底「目录身份在进程生命周期内变化」(目录后变成 worktree 等) 的极端
 * 场景; 归一化本身幂等 (仓库根再解析返回自身), 缓存不破坏正确性。
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { buildMemoryScopeKey, SSH_SCOPE_KEY_PREFIX } from './storage.js';

const BOT_SCOPE_KEY_PREFIX = 'bot:';
const USER_SCOPE_KEY_PREFIX = 'user:';

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
  // 已经是复合键 (bot: / ssh: / user:) 时不得再当本地路径做 git 归一化。
  // Bot scope 由 host 显式注入; SSH 复合键若被二次传入同样原样透传。
  if (
    workingDir.startsWith(BOT_SCOPE_KEY_PREFIX)
    || workingDir.startsWith(SSH_SCOPE_KEY_PREFIX)
    || workingDir.startsWith(USER_SCOPE_KEY_PREFIX)
  ) {
    return workingDir;
  }

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
 * 本地 cwd → 所在仓库的主工作树根。单次 rev-parse 拿 toplevel / git-dir /
 * git-common-dir / superproject 四个值 (输出顺序与参数一致; 无 superproject 时
 * 第四行为空), 探测方式与 desktop WorktreeManager 同模式: rev-parse + path.resolve
 * 解析相对输出 (兼容不支持 --path-format 的旧 git)。失败抛错由调用方回落。
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

  // 判定链:
  //  1. 有 superproject → cwd 在 submodule 里。submodule 属于外层项目, 把**最外层**
  //     superproject (walk 链, 不是直接父) 当映射根: 二级 submodule 的直接父是另一层
  //     submodule, 在那一层跑 `git worktree list` 会把 `.git` 元数据目录报成唯一
  //     worktree (Codex #2399 P1)。
  //  2. 无 superproject 且 gitdir == common-dir → 普通 clone / --separate-git-dir
  //     checkout, 仓库根就是 toplevel, 不再问 `git worktree list`:
  //     `git clone --separate-git-dir` 不写 core.worktree, git 会把 gitdir 的父目录
  //     报成主工作树 (Codex review on #2399), 该布局下 toplevel 才是真实 checkout。
  //  3. 无 superproject 且 gitdir ≠ common-dir → linked worktree, 归到主工作树根。
  //     bare repo 的 worktree (common-dir 是 `<name>.git`) 没有主工作树可归,
  //     用它自己的根。
  const outermostSuper = directSuper
    ? await walkOutermostSuperproject(directSuper, execGit)
    : null;
  if (!outermostSuper) {
    if (samePath(gitDir, commonDir)) return callerSpelledRoot(workingDir, cwd, toplevel);
    if (path.basename(commonDir) !== '.git') return callerSpelledRoot(workingDir, cwd, toplevel);
  }

  const mappingRoot = outermostSuper ?? toplevel;
  // 主工作树根不能从 common-dir 推导: 主 checkout 本身用 --separate-git-dir 建时
  // common-dir 是 git 存储目录, dirname 不一定是工作树。统一用
  // `git worktree list --porcelain` 第一条记录 — git 保证主工作树排第一。
  const mainRoot = await resolveMainWorktreeRoot(mappingRoot, execGit);
  if (!mainRoot || samePath(mappingRoot, mainRoot)) {
    return callerSpelledRoot(workingDir, cwd, mappingRoot);
  }
  return mainRoot;
}

/**
 * cwd 所在的仓库根, 沿用调用方传入路径的写法。
 *
 * git 报的是物理路径; 调用方经符号链接进入仓库时 (macOS `/tmp` → `/private/tmp`),
 * 直接返回 git 的写法会让同一仓库换一个 scope key, 旧记忆就找不到了。能按
 * 调用方的写法逐级上溯到仓库根时用调用方的写法, 对不上再用 git 的写法。
 */
async function callerSpelledRoot(workingDir: string, cwd: string, root: string): Promise<string> {
  let rel = path.relative(root, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // 写法对不上 (符号链接): 用 cwd 的物理路径算出它在仓库里有多深, 再按调用方的
    // 写法上溯同样多层。物理路径也对不上就用 git 的写法。
    const real = await fs.realpath(cwd).catch(() => null);
    rel = real ? path.relative(root, real) : rel;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return root;
  }
  // cwd 就是仓库根: 去掉结尾的分隔符, 否则 `/repo/` 与从子目录解析出的 `/repo` 是两把钥匙。
  if (rel === '') {
    const trimmed = workingDir.replace(/[\\/]+$/, '');
    // 文件系统根 (`/`、`C:\\`) 本身以分隔符结尾, 不动。
    return trimmed && !trimmed.endsWith(':') ? trimmed : workingDir;
  }
  let dir = cwd;
  for (const _segment of rel.split(path.sep)) dir = path.dirname(dir);
  return dir;
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
    const key = process.platform === 'win32' ? current.toLowerCase() : current;
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
