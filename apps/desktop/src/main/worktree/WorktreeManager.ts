/**
 * worktree-parallel-sessions M1: 主入口。
 *
 * 所有 git/fs/store 操作的唯一编排者。renderer 通过 IPC 调用 createWorktree /
 * detectCwd / suggestName / listBranches / getForSession / listAll / reveal,
 * 都收口到这里。
 *
 * removeWorktreeForSession 不暴露通用删除 IPC；唯一远程例外是
 * discardPrecreatedWorktree，它只回收「会话尚未落库」且 path 或 recoveryKey 与创建
 * 记录精确匹配的预创建 worktree，调用方还必须注入实时 ownership guard。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  blocksManagedWorktreeBranchNamespace,
  generateUniqueName,
  avoidCollision,
  getBranchName,
  getManagedWorktreeNameFromBranch,
  getManagedWorktreeReservedName,
  isManagedWorktreeBranchForName,
  validateWorktreeName,
} from './nameGenerator';
import { readAttachedWorktreeBranch } from './attachedBranch';
import { classifyError, type ClassifyInput } from './errorClassifier';
import { gitExec, GitExecError } from './gitExec';
import { applyWorktreeIncludeFile, listChangedWorktreeIncludeFiles } from './includePatternsEngine';
import { hasKeepSentinel, isManagedWorktreePath } from './safety';
import {
  isWorktreeDirty,
  listNonReproducibleIgnoredFiles,
  autoStashDirtyWorktree,
  restoreAutoStashToPreservedWorktree,
} from './dirty';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import { withWorktreeRestoreMutation } from './restoreLock';
import * as store from './worktreeStore';
import { createLogger } from '../logger';
import {
  getManagedWorktreeBasePath,
  MANAGED_WORKTREE_DIR_NAME,
} from '../../shared/managedWorktreePaths';

const log = createLogger('WorktreeManager');

import type {
  CreateWorktreeReq,
  CreateWorktreeResp,
  DetectCwdResp,
  ListBranchesResp,
  WorktreeMeta,
} from './types';

// ── 内部辅助 ───────────────────────────────────────────────────────────────

function classifyAny(err: unknown): ClassifyInput {
  if (err instanceof GitExecError) {
    return {
      stderr: err.stderr,
      exitCode: err.exitCode,
      cause: err.cause ?? err,
    };
  }
  if (err instanceof Error) {
    return {
      stderr: err.message,
      cause: err,
    };
  }
  return { stderr: String(err) };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function clearQuarantinePath(meta: WorktreeMeta): WorktreeMeta {
  const next = { ...meta };
  delete next.quarantinePath;
  return next;
}

function isExpectedQuarantinePath(meta: WorktreeMeta, candidate: string): boolean {
  try {
    return path.resolve(candidate).startsWith(`${path.resolve(meta.path)}.xdt-removing-`);
  } catch {
    return false;
  }
}

function activeWorktreePath(meta: WorktreeMeta): string {
  return meta.quarantinePath ?? meta.path;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    log.info(`[worktree:create] ${label} completed in ${Date.now() - startedAt}ms`);
    return result;
  } catch (err) {
    log.warn(
      `[worktree:create] ${label} failed after ${Date.now() - startedAt}ms:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

const createWorktreeQueues = new Map<string, Promise<void>>();
const precreatedWorktreeOperationQueues = new Map<string, Promise<void>>();
const MIN_RECOVERY_KEY_LENGTH = 16;
const MAX_RECOVERY_KEY_LENGTH = 256;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

async function withCreateWorktreeQueue<T>(baseRepo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(baseRepo);
  const previous = createWorktreeQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  createWorktreeQueues.set(key, queued);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (createWorktreeQueues.get(key) === queued) {
      createWorktreeQueues.delete(key);
    }
  }
}

/**
 * recoveryKey 创建与按键回收必须按 sessionId 串行：手机可能在 create 回包前退出并
 * 很快重连，若回收在 create 最后的 store.set 之前把“暂时 absent”当成功，create
 * 随后仍会落下一份已失去手机账本的孤儿记录。
 */
async function withPrecreatedWorktreeOperationQueue<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = precreatedWorktreeOperationQueues.get(sessionId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  precreatedWorktreeOperationQueues.set(sessionId, queued);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (precreatedWorktreeOperationQueues.get(sessionId) === queued) {
      precreatedWorktreeOperationQueues.delete(sessionId);
    }
  }
}

// ── 公共 API ───────────────────────────────────────────────────────────────

/**
 * 探测 cwd 状态: 是否 git repo / 是否在 worktree 内 / git 是否可用 / 当前分支 / repo root
 */
export async function detectCwd(cwd: string): Promise<DetectCwdResp> {
  const out: DetectCwdResp = {
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
    supportsRecoveryKeyDiscard: true,
  };
  // 1. git --version 探测安装
  try {
    await gitExec(['--version']);
  } catch (err) {
    if (err instanceof GitExecError && err.cause?.code === 'ENOENT') {
      out.gitInstalled = false;
      return out;
    }
    // 其他失败也视为不可用(极罕见)
    out.gitInstalled = false;
    return out;
  }

  // 2. rev-parse --show-toplevel: 拿 repo 根
  try {
    const { stdout } = await gitExec(['rev-parse', '--show-toplevel'], cwd);
    const toplevel = stdout.trim();
    if (toplevel) {
      out.isGitRepo = true;
      out.repoRoot = path.resolve(toplevel);
    }
  } catch {
    out.isGitRepo = false;
  }

  if (!out.isGitRepo) return out;

  // 3. 当前分支
  try {
    const { stdout } = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') out.currentBranch = branch;
  } catch {
    // ignore — 分支信息不影响主流程
  }

  // 4. 是否在 linked worktree 内
  // 权威判定: `git rev-parse --git-dir` 在 linked worktree 里指向 `.git/worktrees/<name>`,
  // 而 `--git-common-dir` 始终指向主仓库的 `.git`。两者解析后的绝对路径不一致 → linked worktree。
  // 这种判断是 git 自己用来区分主/linked worktree 的方式, 不依赖目录命名约定 ——
  // 任何工具(CC Desktop / 手工 git worktree add 等) 创建的 worktree 都能被检出。
  try {
    const [{ stdout: gitDirRaw }, { stdout: gitCommonDirRaw }] = await Promise.all([
      gitExec(['rev-parse', '--git-dir'], cwd),
      gitExec(['rev-parse', '--git-common-dir'], cwd),
    ]);
    const gitDir = path.resolve(cwd, gitDirRaw.trim());
    const gitCommonDir = path.resolve(cwd, gitCommonDirRaw.trim());
    if (gitDir && gitCommonDir && gitDir !== gitCommonDir) {
      out.isInsideWorktree = true;
    }
  } catch {
    // 解析失败 → 兜底走托管目录名启发式, 至少识别出 Cindy 自己创建的 worktree
    const normalizedRepoRoot = out.repoRoot?.replace(/\\/g, '/');
    if (normalizedRepoRoot && getManagedWorktreeBasePath(normalizedRepoRoot) != null) {
      out.isInsideWorktree = true;
    }
  }

  return out;
}

/**
 * 列出 baseRepo 的所有本地分支 + 当前分支。
 * 用 `git branch --format=%(refname:short)` 拿干净的分支列表。
 */
export async function listBranches(baseRepo: string): Promise<ListBranchesResp> {
  const { stdout } = await gitExec(['branch', '--format=%(refname:short)'], baseRepo);
  const branches = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let current = '';
  try {
    const { stdout: cur } = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], baseRepo);
    current = cur.trim();
  } catch {
    // ignore
  }
  return { branches, current };
}

/**
 * 把 ref(如 HEAD)解析为 commit SHA;repoDir 可以是主仓根或 linked worktree
 * 路径。解析失败返回 null(调用方自行回退)。
 */
export async function revParseCommit(repoDir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(['rev-parse', '--verify', `${ref}^{commit}`], repoDir);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 列出已被本仓库占用的名字: store 里 sessionId → name + 当前/历史托管分支去前缀。
 * 用于 nameGenerator 冲突避让 + create 阶段二次校验。
 */
async function getTakenNames(baseRepo: string): Promise<string[]> {
  const taken = new Set<string>();
  // store
  for (const meta of store.getAll()) {
    if (meta.baseRepo === baseRepo || path.resolve(meta.baseRepo) === path.resolve(baseRepo)) {
      taken.add(meta.name);
    }
  }
  // 本地与 origin tracking 分支都纳入占用判定：否则本地无 xdt/foo、
  // 远端尚有 origin/xdt/foo 时又新建 cindy/foo，回收后会出现双候选歧义。
  // 必须保留完整 ref namespace；短名 `origin/cindy` 既可能是本地
  // refs/heads/origin/cindy，也可能是 refs/remotes/origin/cindy，不能靠字符串去前缀猜。
  let branchesOutput: string;
  try {
    ({ stdout: branchesOutput } = await gitExec(
      ['branch', '--all', '--format=%(refname)'],
      baseRepo,
    ));
  } catch {
    // ignore — 拿不到 git 分支时仅用 store
    return [...taken];
  }
  const localRefPrefix = 'refs/heads/';
  const originRefPrefix = 'refs/remotes/origin/';
  for (const line of branchesOutput.split(/\r?\n/)) {
    const ref = line.trim();
    const isLocal = ref.startsWith(localRefPrefix);
    const isOriginTracking = ref.startsWith(originRefPrefix);
    if (!isLocal && !isOriginTracking) continue;

    const branch = ref.slice((isLocal ? localRefPrefix : originRefPrefix).length);
    const displayBranch = isLocal ? branch : `origin/${branch}`;
    if (isLocal && blocksManagedWorktreeBranchNamespace(branch)) {
      throw new Error(
        `无法创建 Cindy Worktree：分支 "${displayBranch}" 占用了 "cindy/*" 命名空间。请先重命名或删除该分支。`,
      );
    }
    // 本地 current-prefix 后代 ref 会在 refs/heads 下真实阻塞父级，需预留首段；
    // origin tracking refs 与本地 heads 分属不同 namespace，仅精确托管分支参与占用。
    const reservedName = isLocal
      ? getManagedWorktreeReservedName(branch)
      : getManagedWorktreeNameFromBranch(branch);
    if (reservedName) taken.add(reservedName);
  }
  return [...taken];
}

/**
 * 给 worktree 创建表单用的"建议名"。已避让 baseRepo 内已用名字。
 */
export async function suggestName(baseRepo: string): Promise<string> {
  const taken = await getTakenNames(baseRepo);
  return generateUniqueName(taken);
}

/** Pool 与完整创建流程共用的显式名称避让入口。 */
export async function resolveAvailableWorktreeName(
  baseRepo: string,
  requestedName: string,
): Promise<string> {
  return avoidCollision(requestedName, await getTakenNames(baseRepo));
}

export function getForSession(sessionId: string): WorktreeMeta | null {
  return store.get(sessionId);
}

export function listAll(): WorktreeMeta[] {
  return store.getAll();
}

// ── 性能优化: deferred checkout (对齐 CC Desktop) ──────────────────────────

/**
 * stageCheckout 阶段拉取的"agent 启动必读"文件白名单。
 *
 * 设计逻辑(对齐 CC Desktop 的 xIn 数组):
 *   - 这些是 agent 启动 / 初始化时立刻读的文件;
 *   - 其余 working tree 在后台异步 checkout;
 *   - SDK 工具 (Read/Edit/Bash) 走 git plumbing 时不依赖物理文件存在,
 *     所以即使后台 checkout 没完成, agent 也能正常工作。
 *
 * xdt-maker 比 CC Desktop 多一个 .sivi(Sivi Studio 的 souls/skills 配置)。
 */
const STAGE_CHECKOUT_PATHS = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude',
  '.sivi',
  '.mcp.json',
] as const;

/**
 * stageCheckout: 仅 checkout 白名单中的关键文件, 后台并行跑全 checkout。
 *
 * 返回:
 *   - 调用方 await 这个函数, 拿到 fullCheckoutPromise(后台全 checkout 的句柄)
 *   - fullCheckoutPromise 不要在 createWorktree 内 await, 让 IPC 立刻返回
 *   - 调用方应 .catch(()=>{}) 防止 unhandled rejection
 */
async function stageCheckout(
  worktreePath: string,
): Promise<{ fullCheckoutPromise: Promise<void> }> {
  const t0 = Date.now();

  // 1. 找出白名单中实际存在于 HEAD 的路径(没的就跳过, 避免 git checkout 报错)。
  //    必须在 **worktree** 里解析 HEAD(= 新分支/sourceBranch 的树),不能用
  //    baseRepo 的当前 checkout:sourceBranch 可能是刚 fetch 的远端默认分支,
  //    与 baseRepo 本地 HEAD 相差可以很远——规则文件只存在于新基底时,按旧树
  //    枚举会漏检,agent 就会在 AGENTS.md/CLAUDE.md 落盘前启动。
  let existingPaths: string[] = [];
  try {
    const { stdout } = await gitExec(
      ['ls-tree', '--name-only', 'HEAD', '--', ...STAGE_CHECKOUT_PATHS],
      worktreePath,
    );
    existingPaths = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    // ls-tree 失败极罕见(空仓库才会), 直接跳过 stageCheckout
    log.warn(
      `[stageCheckout] ls-tree failed for ${worktreePath}, skipping selective checkout:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2. 选择性 checkout 白名单文件(同步, 用户可见)
  if (existingPaths.length > 0) {
    try {
      await gitExec(['checkout', 'HEAD', '--', ...existingPaths], worktreePath);
      log.info(
        `[stageCheckout] selective checkout done in ${Date.now() - t0}ms (${existingPaths.length} paths)`,
      );
    } catch (err) {
      log.warn(
        `[stageCheckout] selective checkout failed for ${worktreePath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 3. 后台跑全 checkout: 排除已 checkout 的目录避免重复 / 覆盖
  //    (单文件如 CLAUDE.md 即使重复 checkout 也无害, 不需要 exclude)
  //    LC_ALL=C 让 git 报错文案一致, 便于解析。
  const bgT0 = Date.now();
  const fullCheckoutPromise = gitExec(
    ['checkout', 'HEAD', '--', '.', ':(exclude).claude', ':(exclude).sivi'],
    worktreePath,
    { extraEnv: { LC_ALL: 'C' } },
  )
    .then(() => {
      log.info(
        `[stageCheckout] background full checkout done for ${worktreePath} in ${Date.now() - bgT0}ms`,
      );
    })
    .catch((err: unknown) => {
      log.warn(
        `[stageCheckout] background full checkout failed for ${worktreePath}:`,
        err instanceof Error ? err.message : String(err),
      );
      // 把错误重抛, 调用方可 .catch 接收(但 createWorktree 不 await)
      throw err;
    });

  return { fullCheckoutPromise };
}

// ── createWorktree 核心 ────────────────────────────────────────────────────

interface CreatedSnapshot {
  /** 已 mkdirp 的父目录(dirname). 若 worktree add 失败需要清理。 */
  parentEnsured?: string;
  /** git worktree add 已成功执行(此时 worktree path 真实存在)。 */
  worktreeAdded?: { path: string; baseRepo: string };
}

async function rollbackPartialCreate(snap: CreatedSnapshot): Promise<void> {
  // 反向回滚: 仅当 git worktree add 已成功时, 用 git worktree remove --force 撤销
  if (snap.worktreeAdded) {
    const { path: wp, baseRepo } = snap.worktreeAdded;
    try {
      await gitExec(['worktree', 'remove', '--force', wp], baseRepo);
    } catch (err) {
      log.warn(
        `[worktree] rollback git worktree remove failed for ${wp}:`,
        err instanceof Error ? err.message : String(err),
      );
      // 尝试 fs.rm 兜底(只在 isManagedWorktreePath 通过时)
      if (isManagedWorktreePath(wp, baseRepo, [wp])) {
        try {
          await fs.rm(wp, { recursive: true, force: true });
        } catch {
          /* 已经尽力, 留给用户手动清理 */
        }
      }
    }
  }
  // parentEnsured 不清理 — 托管 worktree 根目录本身留着没坏处, 下次复用
}

async function configureHooksPath(worktreePath: string, baseRepo: string): Promise<void> {
  // 让 worktree 的 hooks 仍指向源 repo 的 .git/hooks(共享 husky / pre-commit 等)
  // git config 的路径以正斜杠书写最稳妥(Windows 下反斜杠会被转义), 这里统一标准化
  const hooksPath = path.join(baseRepo, '.git', 'hooks').replace(/\\/g, '/');
  await gitExec(['-C', worktreePath, 'config', 'core.hooksPath', hooksPath]);
}

const CLAUDE_COPY_EXCLUDED_TOP_LEVEL_DIRS = new Set(['worktrees']);

export interface CopyClaudeSiviDirsOptions {
  /** 默认覆盖目标文件；恢复快照后可关闭，避免覆盖用户刚还原的配置。 */
  overwriteExisting?: boolean;
}

interface CopyDirOptions extends CopyClaudeSiviDirsOptions {
  /** Top-level children under src that should not be copied. */
  excludeTopLevelDirs?: ReadonlySet<string>;
  /** 仓库根相对(posix 分隔)路径黑名单:命中的文件不复制(受控内容由 checkout 提供)。 */
  skipRepoRelPaths?: ReadonlySet<string>;
  /** 计算 skipRepoRelPaths 相对路径所用的仓库根。 */
  repoRoot?: string;
}

function shouldCopyPath(srcRoot: string, srcPath: string, opts?: CopyDirOptions): boolean {
  const excluded = opts?.excludeTopLevelDirs;
  if (!excluded || excluded.size === 0) return true;

  const rel = path.relative(srcRoot, srcPath);
  if (!rel) return true;

  const [topLevel] = rel.split(path.sep);
  return !excluded.has(topLevel);
}

export async function copyDirIfExists(
  src: string,
  dest: string,
  opts?: CopyDirOptions,
): Promise<void> {
  try {
    const stat = await fs.stat(src);
    if (!stat.isDirectory()) return;
  } catch {
    return; // 不存在就跳过
  }
  // dereference: false 保留软链(.claude/agents 里有人用软链); errorOnExist:false 允许覆盖
  await fs.cp(src, dest, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
    filter: async (srcPath, destPath) => {
      if (!shouldCopyPath(src, srcPath, opts)) return false;
      if (opts?.skipRepoRelPaths && opts.repoRoot) {
        const rel = path.relative(opts.repoRoot, srcPath).split(path.sep).join('/');
        if (opts.skipRepoRelPaths.has(rel)) return false;
      }
      if (opts?.overwriteExisting !== false) return true;
      const srcStat = await fs.lstat(srcPath);
      if (srcStat.isDirectory()) return true;
      try {
        await fs.lstat(destPath);
        return false;
      } catch {
        return true;
      }
    },
  });
}

/**
 * .claude/.sivi 下应受保护(复制时跳过)的受控文件集(仓库根相对路径,posix 分隔),
 * 取两个来源的**并集**:
 *  - baseRepo 索引的跟踪文件:上游已删除的也要保护,不把旧文件补回新基底;
 *  - 目标 worktree HEAD 树(= sourceBranch)的文件:baseRepo 尚未跟踪、sourceBranch
 *    已开始跟踪的场景必须靠它——否则本地未跟踪的同名旧配置会覆盖新基底刚检出的
 *    受控内容并立刻 dirty。
 * 单侧查询失败按空集处理(fail-open,最坏退回全量复制的旧行为)。
 */
async function listProtectedClaudeSiviPaths(
  baseRepo: string,
  worktreePath: string,
): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  try {
    const { stdout } = await gitExec(['ls-files', '-z', '--', '.claude', '.sivi'], baseRepo);
    for (const p of stdout.split('\0')) if (p) out.add(p);
  } catch {
    /* fail-open */
  }
  try {
    const { stdout } = await gitExec(
      ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', '.claude', '.sivi'],
      worktreePath,
    );
    for (const p of stdout.split('\0')) if (p) out.add(p);
  } catch {
    /* fail-open */
  }
  return out;
}

/**
 * git worktree add 参数(导出仅供单测断言)。--no-track 是分支边界约束:sourceBranch
 * 现在常是远端跟踪引用(refs/remotes/<remote>/<默认分支>),不加它 git 会按
 * branch.autoSetupMerge 默认给新托管分支挂上对远端默认分支的 upstream 配置
 * (branch.<name>.remote/merge)——此后裸 git push/pull 可能误推/误并默认分支,
 * 破坏自动 worktree 的独立分支边界;起点是本地分支时 --no-track 为无害 no-op。
 */
export function buildWorktreeAddArgs(
  branch: string,
  worktreePath: string,
  sourceBranch: string,
): string[] {
  return [
    '-c',
    'core.longpaths=true',
    'worktree',
    'add',
    '--no-checkout',
    '--no-track',
    '-b',
    branch,
    worktreePath,
    sourceBranch,
  ];
}

export async function copyClaudeSiviDirs(
  baseRepo: string,
  worktreePath: string,
  options: CopyClaudeSiviDirsOptions = {},
): Promise<void> {
  // 只补复制 baseRepo 里**未被 git 跟踪**的本地配置(settings.local.json 之类):
  // 被跟踪的受控内容已由 stageCheckout / 池 reset 按 worktree 的 sourceBranch
  // 检出——用 baseRepo 旧 checkout 覆盖会让自动 worktree 带着旧 Agent 配置启动,
  // 且这些文件与新 HEAD 不同时一创建就 dirty(后台完整 checkout 明确排除
  // .claude/.sivi,永远不会修复)。
  const tracked = await listProtectedClaudeSiviPaths(baseRepo, worktreePath);
  await copyDirIfExists(path.join(baseRepo, '.claude'), path.join(worktreePath, '.claude'), {
    excludeTopLevelDirs: CLAUDE_COPY_EXCLUDED_TOP_LEVEL_DIRS,
    overwriteExisting: options.overwriteExisting,
    skipRepoRelPaths: tracked,
    repoRoot: baseRepo,
  });
  await copyDirIfExists(path.join(baseRepo, '.sivi'), path.join(worktreePath, '.sivi'), {
    overwriteExisting: options.overwriteExisting,
    skipRepoRelPaths: tracked,
    repoRoot: baseRepo,
  });
}

/**
 * 主入口: 创建一个 worktree 并把元信息写入 store + DB。
 *
 * 串行步骤 (任一失败 → classifyError → 返回 ok:false; 已建半成品需回滚):
 *   1. detectCwd 校验(isGitRepo / gitInstalled / !isInsideWorktree)
 *   2. listBranches 校验 sourceBranch 存在
 *   3. 计算 path = baseRepo/.cindy-worktrees/<name>; 已存在 → 重新 avoidCollision 拿一个
 *   4. mkdirp parent
 *   5. git worktree add -b cindy/<name> <path> <sourceBranch>
 *      失败时若 stderr 含 core.longpaths → 自动 git config --global core.longpaths true 重试一次
 *   6. configureHooksPath
 *   7. copyClaudeSiviDirs(跳过 .claude/worktrees 这类历史工作区状态)
 *   8. applyWorktreeIncludeFile
 *   9. git config --global --add safe.directory <path>
 *  10. worktreeStore.set(sessionId, meta) → 同步写 sessions.worktree_path
 */
export async function createWorktree(req: CreateWorktreeReq): Promise<CreateWorktreeResp> {
  const create = () => withCreateWorktreeQueue(req.baseRepo, () => createWorktreeInner(req));
  return req.recoveryKey === undefined
    ? create()
    : withPrecreatedWorktreeOperationQueue(req.sessionId, create);
}

async function createWorktreeInner(req: CreateWorktreeReq): Promise<CreateWorktreeResp> {
  const snap: CreatedSnapshot = {};
  const totalStartedAt = Date.now();
  try {
    // 0. 防御性校验 worktree name(IPC 不可信, UI 当前虽然只走自动生成,
    //    但调试 / 未来扩展 / 误用都可能传入非法值)。
    //    要求: [a-z0-9-], 首尾字母数字, 无连续 --, 长度 ≤20。
    //    符合 git ref + Windows/POSIX 路径 + cli flag 安全的交集。
    const nameError = validateWorktreeName(req.name);
    if (nameError) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: `worktree 名称非法: ${nameError}`,
          hint: `示例合法值: pensive-lederberg, auto-3l9k0c`,
        },
      };
    }
    const recoveryKey = typeof req.recoveryKey === 'string' ? req.recoveryKey.trim() : null;
    if (
      req.recoveryKey !== undefined &&
      (!recoveryKey ||
        recoveryKey.length < MIN_RECOVERY_KEY_LENGTH ||
        recoveryKey.length > MAX_RECOVERY_KEY_LENGTH ||
        !RECOVERY_KEY_PATTERN.test(recoveryKey))
    ) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: 'worktree 恢复关联键非法',
        },
      };
    }

    // 1. detect
    const cwdInfo = await timed('detect cwd', () => detectCwd(req.baseRepo));
    if (!cwdInfo.gitInstalled) {
      return {
        ok: false,
        error: classifyError({ cause: { code: 'ENOENT', syscall: 'spawn git' } }),
      };
    }
    if (!cwdInfo.isGitRepo) {
      return { ok: false, error: classifyError({ stderr: 'not a git repository' }) };
    }
    if (cwdInfo.isInsideWorktree) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: '当前目录已在 git worktree 内, 不能在其中再创建 worktree',
        },
      };
    }
    const baseRepo = cwdInfo.repoRoot ?? path.resolve(req.baseRepo);

    // 2. branches — sourceBranch 既可以是本地分支(常规 schedule),也可以是
    //    任意 commit-ish。
    //    本地分支命中优先,否则用 rev-parse 校验是不是合法 commit-ish。
    const { branches } = await timed('list branches', () => listBranches(baseRepo));
    if (!branches.includes(req.sourceBranch)) {
      try {
        await gitExec(['rev-parse', '--verify', `${req.sourceBranch}^{commit}`], baseRepo);
      } catch {
        return {
          ok: false,
          error: {
            kind: 'unknown',
            message: `源分支 "${req.sourceBranch}" 不存在`,
            hint: '请刷新分支列表或选择其他源分支',
          },
        };
      }
    }

    // 3. 路径冲突避让
    const taken = await timed('collect taken names', () => getTakenNames(baseRepo));
    // 显式 collision（含大小写与 ref 层级冲突）统一走 avoidCollision。
    let name = avoidCollision(req.name, taken);
    let worktreePath = path.join(baseRepo, MANAGED_WORKTREE_DIR_NAME, name);
    // 文件系统 collision(store 没记录但目录已存在): 多走一次 avoid
    let attempts = 0;
    while ((await pathExists(worktreePath)) && attempts < 100) {
      const all = [...taken, name];
      name = avoidCollision(name, all);
      worktreePath = path.join(baseRepo, MANAGED_WORKTREE_DIR_NAME, name);
      attempts += 1;
    }

    // 4. mkdirp parent
    const parentDir = path.dirname(worktreePath);
    await timed('ensure parent directory', () => fs.mkdir(parentDir, { recursive: true }));
    snap.parentEnsured = parentDir;

    // 5. git worktree add(--no-checkout 跳过文件解压, 加速主流程; longpaths 自动重试)
    //    对齐 CC Desktop: 大型仓库的全 checkout 可能耗时数十秒, 改成只建 worktree 元数据,
    //    后续 stageCheckout 同步拉关键文件, 全 checkout 后台跑。
    const branch = getBranchName(name);
    const addArgs = buildWorktreeAddArgs(branch, worktreePath, req.sourceBranch);
    try {
      await timed('git worktree add', () => gitExec(addArgs, baseRepo));
    } catch (err) {
      if (err instanceof GitExecError && /filename too long|core\.longpaths/i.test(err.stderr)) {
        // 启用 core.longpaths 后重试一次
        try {
          await gitExec(['config', '--global', 'core.longpaths', 'true']);
          await timed('git worktree add retry', () => gitExec(addArgs, baseRepo));
        } catch (retryErr) {
          return { ok: false, error: classifyError(classifyAny(retryErr)) };
        }
      } else {
        return { ok: false, error: classifyError(classifyAny(err)) };
      }
    }
    snap.worktreeAdded = { path: worktreePath, baseRepo };

    // 5b. stageCheckout: 同步拉 agent 启动必读文件(.claude/.sivi/CLAUDE.md/...),
    //     后台跑全 checkout。fullCheckoutPromise 故意 fire-and-forget,
    //     失败仅日志, 不阻塞 IPC 返回。
    let bgPromise: Promise<void> | undefined;
    try {
      const stageRes = await timed('stage checkout', () => stageCheckout(worktreePath));
      bgPromise = stageRes.fullCheckoutPromise;
    } catch (err) {
      // stageCheckout 内部已记 warn, 这里再保险记一条; 不视为致命
      log.warn(
        `[worktree] stageCheckout failed for ${worktreePath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // 防止 unhandled rejection(stageCheckout 已设 .catch 但再保险一次)
    bgPromise?.catch(() => {});

    // 6. hooks
    try {
      await timed('configure hooks', () => configureHooksPath(worktreePath, baseRepo));
    } catch (err) {
      await rollbackPartialCreate(snap);
      return { ok: false, error: classifyError(classifyAny(err)) };
    }

    // 7. copy .claude / .sivi(目录不存在则跳过)
    try {
      await timed('copy .claude/.sivi', () => copyClaudeSiviDirs(baseRepo, worktreePath));
    } catch (err) {
      // 拷贝失败不致命(.claude/.sivi 是辅助), 但仍记录并继续
      log.warn(
        `[worktree] copy .claude/.sivi failed for ${worktreePath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 8. include patterns
    try {
      const results = await timed('apply include file', () =>
        applyWorktreeIncludeFile(baseRepo, worktreePath),
      );
      const failed = results.filter((r) => r.status === 'failed');
      if (failed.length > 0) {
        log.warn(
          `[worktree] ${failed.length} include files failed to copy:`,
          failed.slice(0, 5).map((f) => `${f.relpath}: ${f.error ?? '<no error>'}`),
        );
      }
    } catch (err) {
      log.warn(
        `[worktree] applyWorktreeIncludeFile failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 9. safe.directory
    try {
      await timed('add safe.directory', () =>
        gitExec(['config', '--global', '--add', 'safe.directory', worktreePath]),
      );
    } catch (err) {
      // 非致命 — 仅日志
      log.warn(
        `[worktree] add safe.directory failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 10. store + DB
    const meta: WorktreeMeta = {
      sessionId: req.sessionId,
      name,
      path: worktreePath,
      baseRepo,
      branch,
      sourceBranch: req.sourceBranch,
      createdAt: nowIso(),
      ...(recoveryKey ? { recoveryKey } : {}),
      ephemeral: req.ephemeral ?? false,
    };
    await timed('persist metadata', () => store.set(req.sessionId, meta));

    log.info(`[worktree:create] total completed in ${Date.now() - totalStartedAt}ms`);
    return { ok: true, meta };
  } catch (err) {
    // 兜底: 任何未捕获的异常走 classifier + rollback
    await rollbackPartialCreate(snap);
    log.warn(
      `[worktree:create] failed after ${Date.now() - totalStartedAt}ms:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, error: classifyError(classifyAny(err)) };
  }
}

/**
 * 删除/归档确认框的 worktree 预检(P1):有没有会被回收的 worktree、是否有未提交
 * 更改。ephemeral(scheduler 池)不算——它不走删除回收。查询失败按最保守的
 * "有脏改动"报,确认文案宁可多提示。
 */
export async function getRemovalPreview(
  sessionId: string,
): Promise<{ hasWorktree: boolean; dirty: boolean }> {
  const meta = store.get(sessionId);
  if (!meta || meta.ephemeral) return { hasWorktree: false, dirty: false };
  const worktreePath = activeWorktreePath(meta);
  try {
    await fs.access(worktreePath);
  } catch {
    return { hasWorktree: false, dirty: false };
  }
  return { hasWorktree: true, dirty: await isWorktreeDirty(worktreePath) };
}

// ── removeWorktreeForSession (无 IPC, 仅会话显式删除/归档路径调) ─────────────

const removeWorktreeQueues = new Map<string, Promise<void>>();

export interface RemoveWorktreeOptions {
  /** destructive remove 前确认 owning session 仍处于允许回收的状态。 */
  canRemove?: () => Promise<boolean>;
  /**
   * 预创建补偿回收不能把用户可能已经手动写入的内容变成无会话可恢复的快照；
   * 命中 dirty 时保留整个 worktree，而不是走常规删除/归档的 auto-stash 流程。
   */
  preserveDirty?: boolean;
}

/**
 * fire-and-forget: 即便失败也不抛, 仅记日志。
 *
 * P0 重构(2026-07)后唯一调用方是会话显式删除/归档触发的
 * sessionRemovalRecycle.recycleWorktreeForRemovedSession —— 不再挂在
 * onClose(子进程退出)上,/clear、鉴权重连、app 退出等瞬态 close 不会再走到这里。
 *
 * 流程:
 *   1. meta = store.get(sid); null → return
 *   2. live-ref 守卫: 其它未删除会话仍引用该路径 → 保留(排除 sid 自身,
 *      归档会话自己的行不算引用)
 *   3. dirty → auto-stash(失败 → 保留);成功后先撤销 store 登记，阻断 SEND
 *   4. try git worktree remove --force <meta.path>
 *   5. fail → isManagedWorktreePath 三条校验通过 → fs.rm -rf
 *   6. 仍失败 → reapply snapshot；成功才恢复 store，失败则保持未登记供发送期恢复
 *   7. 删除成功 → store.del(sid)(dirty 路径幂等；不动 sessions.worktree_path)
 *   8. **不带 -D**: 分支保留
 */
export async function removeWorktreeForSession(
  sessionId: string,
  options: RemoveWorktreeOptions = {},
): Promise<void> {
  const previous = removeWorktreeQueues.get(sessionId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => removeWorktreeForSessionInner(sessionId, options));
  removeWorktreeQueues.set(sessionId, run);
  try {
    await run;
  } finally {
    if (removeWorktreeQueues.get(sessionId) === run) {
      removeWorktreeQueues.delete(sessionId);
    }
  }
}

async function removeWorktreeForSessionInner(
  sessionId: string,
  options: RemoveWorktreeOptions,
): Promise<void> {
  let meta = store.get(sessionId);
  if (!meta) return;
  if (meta.quarantinePath && !isExpectedQuarantinePath(meta, meta.quarantinePath)) {
    log.warn(`[worktree] preserved worktree at ${meta.path}: invalid persisted quarantine path`);
    return;
  }
  const hadPersistedQuarantine = Boolean(meta.quarantinePath);
  // A crash can happen after the quarantine marker is persisted but before Git moves
  // the directory. Repair that preparatory state before attempting another removal.
  if (meta.quarantinePath) {
    const quarantineExists = await pathExists(meta.quarantinePath);
    const originalExists = await pathExists(meta.path);
    if (!quarantineExists && originalExists) {
      const repaired = clearQuarantinePath(meta);
      try {
        await store.set(sessionId, repaired);
      } catch (err) {
        log.warn(
          `[worktree] failed to clear stale quarantine marker for ${meta.path}:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      meta = repaired;
    }
  }
  const removalOptions = hadPersistedQuarantine ? { ...options, preserveDirty: true } : options;
  const worktreePath = activeWorktreePath(meta);

  // 哨兵守卫: 用户放了 .worktree-keep ⇒ 无条件保留(必须在 dirty/stash 之前——
  // 哨兵是 untracked 文件,走到 stash 会连哨兵一起收走再删目录)。
  const guardedPaths = [...new Set([meta.path, worktreePath])];
  if (guardedPaths.some((candidate) => hasKeepSentinel(candidate))) {
    log.info(`[worktree] preserved worktree at ${worktreePath}: has ${'.worktree-keep'} sentinel`);
    return;
  }

  // live-ref 守卫: worktree 路径仍被其它未删除会话的 workingDir / worktreePath
  // 指向时不删(典型: 用户在该目录另开了会话)。查询失败按"在用"保守处理。
  const liveKeys = await loadLiveSessionPathKeys({
    contextPath: worktreePath,
    excludeSessionId: sessionId,
  });
  if (hasLiveSessionReference(meta, liveKeys)) {
    log.info(
      `[worktree] preserved worktree at ${worktreePath}: still referenced by another live session`,
    );
    return;
  }

  // Store 只持久化创建时的托管分支；若用户/Agent 后来切到其它分支或 detached
  // HEAD，当前恢复协议无法在目录删除后可靠重建那个基底。必须在任何 snapshot、
  // quarantine 或 remove 前 fail closed，保留完整 worktree。
  if (!isManagedWorktreeBranchForName(meta.branch, meta.name)) {
    log.warn(
      `[worktree] preserved worktree at ${worktreePath}: registered branch ${meta.branch} ` +
        `is not a managed branch for ${meta.name}`,
    );
    return;
  }
  const attachedBranch = await readAttachedWorktreeBranch(worktreePath);
  if (!attachedBranch) {
    log.warn(
      `[worktree] preserved worktree at ${worktreePath}: cannot confirm an attached HEAD branch`,
    );
    return;
  }
  if (attachedBranch !== meta.branch) {
    log.warn(
      `[worktree] preserved worktree at ${worktreePath}: HEAD branch ${attachedBranch} ` +
        `does not match registered branch ${meta.branch}`,
    );
    return;
  }

  let changedIncludeFiles: Awaited<ReturnType<typeof listChangedWorktreeIncludeFiles>>;
  try {
    changedIncludeFiles = await listChangedWorktreeIncludeFiles(meta.baseRepo, worktreePath);
  } catch (err) {
    log.warn(
      `[worktree] preserve worktree at ${worktreePath}: include-file dirty check failed`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (changedIncludeFiles.length > 0) {
    log.warn(
      `[worktree] preserved worktree at ${worktreePath}: changed included local files`,
      changedIncludeFiles.slice(0, 10).map((f) => `${f.relpath}:${f.reason}`),
    );
    return;
  }

  if (!(await canRemoveWorktree(removalOptions, worktreePath, sessionId))) return;

  if (removalOptions.preserveDirty) {
    let ignoredFiles: string[];
    try {
      ignoredFiles = await listNonReproducibleIgnoredFiles(meta.baseRepo, worktreePath);
    } catch (err) {
      log.warn(
        `[worktree] preserve worktree at ${worktreePath}: ignored-file check failed`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (ignoredFiles.length > 0) {
      log.warn(
        `[worktree] preserved worktree at ${worktreePath}: non-reproducible ignored files`,
        ignoredFiles.slice(0, 10),
      );
      return;
    }
    // ignored-file 对比可能读盘；完成后再核对一次 ownership，避免检查期间晚到的
    // maker:create-session 已认领目录却仍继续删除。
    if (!(await canRemoveWorktree(removalOptions, worktreePath, sessionId))) return;
  }

  const finishRemoval = async (snapshotted: boolean): Promise<void> => {
    if (snapshotted) {
      // The shared mutation lock is already installed before auto-stash starts. Unregister only
      // after the snapshot is durable so SEND waits throughout the clean-worktree window.
      store.del(sessionId);
    }

    // closeSession / snapshot 期间会话可能已恢复为 active。真正删除前再读一次状态；
    // 若本轮已经 snapshot，则把内容重新 apply 回保留目录。
    if (!(await canRemoveWorktree(removalOptions, activeWorktreePath(meta), sessionId))) {
      if (snapshotted) {
        if (await restoreAutoStashToPreservedWorktree(meta.path, sessionId)) {
          await store.set(sessionId, meta);
        } else {
          log.warn(
            `[worktree] recycle cancelled for ${meta.path}, but snapshot reapply failed; ` +
              'worktree stays unregistered so SEND remains blocked until restore succeeds',
          );
        }
      }
      return;
    }

    let removalPath = activeWorktreePath(meta);
    let quarantinePath: string | null = meta.quarantinePath ?? null;
    const restoreQuarantine = async (): Promise<boolean> => {
      if (!quarantinePath) return true;
      const currentQuarantinePath = quarantinePath;
      try {
        await gitExec(['worktree', 'move', currentQuarantinePath, meta.path], meta.baseRepo);
        quarantinePath = null;
        try {
          await store.set(sessionId, clearQuarantinePath(meta));
        } catch (err) {
          log.warn(
            `[worktree] failed to clear persisted quarantine state for ${meta.path}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
        return true;
      } catch (err) {
        log.error(
          `[worktree] failed to restore quarantined worktree ${currentQuarantinePath}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Preserve the actual path if the move-back itself fails; losing the
        // store entry would make the quarantined user data unreachable.
        try {
          await store.set(sessionId, { ...meta, quarantinePath: currentQuarantinePath });
        } catch (storeErr) {
          log.error(
            `[worktree] failed to persist quarantined worktree ${currentQuarantinePath}:`,
            storeErr instanceof Error ? storeErr.message : String(storeErr),
          );
        }
        return false;
      }
    };

    if (removalOptions.preserveDirty && !quarantinePath && (await pathExists(meta.path))) {
      const candidate = `${meta.path}.xdt-removing-${randomUUID()}`;
      try {
        // Persist the intended quarantine path before the rename. This closes both
        // crash windows: after the marker is written but before the move, startup
        // can clear the stale marker because the original path still exists; after
        // the move, startup can continue from the persisted quarantine path.
        await store.set(sessionId, { ...meta, quarantinePath: candidate });
        quarantinePath = candidate;
        removalPath = candidate;
        // Atomically move the registered worktree out of its user-visible path
        // before the final ignored-file scan. New writes through the old path
        // can no longer race the scan and the subsequent remove.
        await gitExec(['worktree', 'move', meta.path, candidate], meta.baseRepo);
      } catch (err) {
        log.warn(
          `[worktree] preserve worktree at ${meta.path}: quarantine move failed`,
          err instanceof Error ? err.message : String(err),
        );
        await restoreQuarantine();
        return;
      }

      // The move updates Git's worktree metadata, so both the final ownership
      // check and ignored-file scan can use the quarantined path.
      if (!(await canRemoveWorktree(removalOptions, removalPath, sessionId))) {
        await restoreQuarantine();
        return;
      }

      let ignoredFiles: string[];
      try {
        ignoredFiles = await listNonReproducibleIgnoredFiles(meta.baseRepo, removalPath);
      } catch (err) {
        log.warn(
          `[worktree] preserve worktree at ${removalPath}: ignored-file check failed`,
          err instanceof Error ? err.message : String(err),
        );
        await restoreQuarantine();
        return;
      }
      if (ignoredFiles.length > 0) {
        log.warn(
          `[worktree] preserved worktree at ${removalPath}: non-reproducible ignored files`,
          ignoredFiles.slice(0, 10),
        );
        await restoreQuarantine();
        return;
      }
      if (!(await canRemoveWorktree(removalOptions, removalPath, sessionId))) {
        await restoreQuarantine();
        return;
      }
    }

    let removedByGit = false;
    try {
      // 预创建补偿回收必须让 git 在删除瞬间再次确认 worktree 仍然干净：
      // preserveDirty 的前置探测与这里之间可能有人刚写入文件，非强制 remove 会拒绝，
      // 从而保留目录。普通会话删除已经有 auto-stash 保护，仍沿用 --force。
      const removeArgs = removalOptions.preserveDirty
        ? ['worktree', 'remove', removalPath]
        : ['worktree', 'remove', '--force', removalPath];
      await gitExec(removeArgs, meta.baseRepo);
      removedByGit = true;
    } catch (err) {
      log.warn(
        `[worktree] git worktree remove failed for ${removalPath}:`,
        err instanceof Error ? err.message : String(err),
      );
      // preserveDirty 是补偿口的“绝不丢用户新写内容”承诺。git 拒绝非强制删除时
      // 不能再用 fs.rm 绕过它，否则会重新打开 dirty check 后写入的竞态窗口。
      if (removalOptions.preserveDirty) {
        await restoreQuarantine();
        return;
      }
      // fallback: fs.rm —— 必须三条校验通过
      if (
        isManagedWorktreePath(removalPath, meta.baseRepo, [...store.getAllPaths(), removalPath])
      ) {
        try {
          await fs.rm(removalPath, { recursive: true, force: true });
          // 让 git worktree 状态自洽
          try {
            await gitExec(['worktree', 'prune'], meta.baseRepo);
          } catch {
            /* prune 失败无影响 */
          }
          removedByGit = true; // 视为已清, 走 store.del
        } catch (rmErr) {
          log.error(
            `[worktree] fs.rm fallback failed for ${removalPath}:`,
            rmErr instanceof Error ? rmErr.message : String(rmErr),
          );
          // 不动 store, 留给用户手动清理或下次启动复用
        }
      } else {
        log.warn(
          `[worktree] isManagedWorktreePath check failed for ${removalPath}; refusing fs.rm`,
        );
      }
    }

    if (removedByGit) {
      store.del(sessionId);
    } else if (snapshotted) {
      // Both removal paths failed: put WIP back before restoring the live registration. If apply
      // also fails, keep it unregistered so the send-time restore gate retries the snapshot.
      if (await restoreAutoStashToPreservedWorktree(meta.path, sessionId)) {
        await store.set(sessionId, meta);
      } else {
        log.warn(
          `[worktree] remove failed for ${meta.path}, and snapshot reapply also failed; ` +
            'worktree stays unregistered until restore succeeds',
        );
      }
    }
  };

  if (await isWorktreeDirty(worktreePath)) {
    if (removalOptions.preserveDirty) {
      log.info(
        `[worktree] preserved worktree at ${worktreePath}: uncommitted changes block pre-created cleanup`,
      );
      return;
    }
    await withWorktreeRestoreMutation(sessionId, async () => {
      if (!(await autoStashDirtyWorktree(worktreePath, sessionId))) {
        log.warn(`[worktree] worktree at ${worktreePath} has uncommitted changes, preserving`);
        return;
      }
      await finishRemoval(true);
    });
    return;
  }
  await finishRemoval(false);
}

export type DiscardPrecreatedWorktreeResult =
  | { status: 'absent' }
  | { status: 'path-mismatch' }
  | { status: 'preserved' }
  | { status: 'discarded'; branchDeleted: boolean };

/**
 * 手机在 worktree:create 之前先持久化 sessionId + recoveryKey；若进程在 create
 * 回包前退出，恢复端拿不到 path。这里仅在随机关联键与被控端持久元数据精确匹配时
 * 解析真实路径，再复用同一套 path / dirty / ownership 删除守卫。
 */
export async function discardPrecreatedWorktreeByRecoveryKey(
  sessionId: string,
  recoveryKey: string,
  options: Pick<RemoveWorktreeOptions, 'canRemove'> = {},
): Promise<DiscardPrecreatedWorktreeResult> {
  return withPrecreatedWorktreeOperationQueue(sessionId, async () => {
    const meta = store.get(sessionId);
    if (!meta) return { status: 'absent' };
    if (!meta.recoveryKey || meta.recoveryKey !== recoveryKey) {
      return { status: 'path-mismatch' };
    }
    return discardPrecreatedWorktree(sessionId, meta.path, options);
  });
}

/**
 * 回收「先 worktree:create、后 maker:create-session」中第二步失败后被放弃的预创建目录。
 *
 * 这是通用删除流程之外的窄补偿口：
 * - expectedPath 必须与 store 中该 sessionId 的受管路径精确匹配，控制端不能指定任意目录；
 * - ephemeral / dirty / keep sentinel / include-file 变化 / live-ref 冲突一律保留；
 * - canRemove 由宿主反复核对「session 未落库且无 live handle」，挡住晚到的 create；
 * - 正常创建后尚无独有 commit 的 cindy/* 或历史 xdt/* 分支才随目录删除；
 *   存在独有 commit 时保留分支。
 */
export async function discardPrecreatedWorktree(
  sessionId: string,
  expectedPath: string,
  options: Pick<RemoveWorktreeOptions, 'canRemove'> = {},
): Promise<DiscardPrecreatedWorktreeResult> {
  const meta = store.get(sessionId);
  if (!meta) return { status: 'absent' };
  const expected = path.resolve(expectedPath);
  const matchesRegisteredPath =
    path.resolve(meta.path) === expected ||
    (meta.quarantinePath !== undefined && path.resolve(meta.quarantinePath) === expected);
  if (!matchesRegisteredPath) {
    return { status: 'path-mismatch' };
  }
  if (meta.ephemeral) return { status: 'preserved' };

  await removeWorktreeForSession(sessionId, {
    ...options,
    preserveDirty: true,
  });
  if (store.get(sessionId)) return { status: 'preserved' };

  // 目录成功移除后再读分支，封住用户在 dirty check 与 worktree remove 之间刚完成
  // commit 的窗口。store 元数据损坏时也绝不删除非本记录自动推导出的分支。
  const isGeneratedBranch = isManagedWorktreeBranchForName(meta.branch, meta.name);
  let branchTipToDelete: string | null = null;
  if (isGeneratedBranch) {
    try {
      const branchRef = `refs/heads/${meta.branch}`;
      const { stdout: branchTip } = await gitExec(
        ['rev-parse', '--verify', `${branchRef}^{commit}`],
        meta.baseRepo,
      );
      const { stdout } = await gitExec(
        ['rev-list', '--count', `${meta.sourceBranch}..${meta.branch}`],
        meta.baseRepo,
      );
      if (stdout.trim() === '0' && branchTip.trim()) {
        branchTipToDelete = branchTip.trim();
      }
    } catch {
      branchTipToDelete = null;
    }
  }

  let branchDeleted = false;
  if (branchTipToDelete) {
    try {
      // expected-old-value 让 ref 删除原子化：rev-list 后若别的进程刚给分支写入 commit，
      // update-ref 会拒绝，而不是用 `branch -D` 抹掉新 tip。
      await gitExec(
        ['update-ref', '-d', `refs/heads/${meta.branch}`, branchTipToDelete],
        meta.baseRepo,
      );
      branchDeleted = true;
    } catch (err) {
      // 目录和 store 已回收；分支删除失败按保守方向留下可恢复引用，不反向报整笔失败。
      log.warn(
        `[worktree] discarded pre-created directory but preserved branch ${meta.branch}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { status: 'discarded', branchDeleted };
}

async function canRemoveWorktree(
  options: RemoveWorktreeOptions,
  worktreePath: string,
  sessionId: string,
): Promise<boolean> {
  if (!options.canRemove) return true;
  try {
    const allowed = await options.canRemove();
    if (!allowed) {
      log.info(
        `[worktree] preserved worktree at ${worktreePath}: session ${sessionId} is no longer removable`,
      );
    }
    return allowed;
  } catch (err) {
    log.warn(
      `[worktree] preserved worktree at ${worktreePath}: remove guard failed`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
