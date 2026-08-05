/**
 * worktree-parallel-sessions M1: 主入口。
 *
 * 所有 git/fs/store 操作的唯一编排者。renderer 通过 IPC 调用 createWorktree /
 * detectCwd / suggestName / listBranches / getForSession / listAll / reveal,
 * 都收口到这里。
 *
 * removeWorktreeForSession 故意不暴露 IPC, 只在 cc-agent:close-session handler
 * 内部调用(fire-and-forget)。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import {
  generateUniqueName,
  avoidCollision,
  getBranchName,
  validateWorktreeName,
} from './nameGenerator';
import {
  classifyError,
  type ClassifyInput,
} from './errorClassifier';
import { gitExec, GitExecError } from './gitExec';
import {
  applyWorktreeIncludeFile,
  listChangedWorktreeIncludeFiles,
} from './includePatternsEngine';
import { hasKeepSentinel, isManagedWorktreePath } from './safety';
import {
  isWorktreeDirty,
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

async function withCreateWorktreeQueue<T>(baseRepo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(baseRepo);
  const previous = createWorktreeQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(() => current, () => current);
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

// ── 公共 API ───────────────────────────────────────────────────────────────

/**
 * 探测 cwd 状态: 是否 git repo / 是否在 worktree 内 / git 是否可用 / 当前分支 / repo root
 */
export async function detectCwd(cwd: string): Promise<DetectCwdResp> {
  const out: DetectCwdResp = {
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
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
  const { stdout } = await gitExec(
    ['branch', '--format=%(refname:short)'],
    baseRepo,
  );
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
 * 列出已被本仓库占用的名字: store 里 sessionId → name + git 分支 xdt/* 去前缀。
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
  // git branches: 仅 xdt/* 前缀
  try {
    const { stdout } = await gitExec(['branch', '--format=%(refname:short)'], baseRepo);
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('xdt/')) taken.add(t.slice('xdt/'.length));
    }
  } catch {
    // ignore — 拿不到 git 分支时仅用 store
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
  baseRepo: string,
): Promise<{ fullCheckoutPromise: Promise<void> }> {
  const t0 = Date.now();

  // 1. 找出白名单中实际存在于 HEAD 的路径(没的就跳过, 避免 git checkout 报错)
  let existingPaths: string[] = [];
  try {
    const { stdout } = await gitExec(
      ['ls-tree', '--name-only', 'HEAD', '--', ...STAGE_CHECKOUT_PATHS],
      baseRepo,
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
  await gitExec(
    ['-C', worktreePath, 'config', 'core.hooksPath', hooksPath],
  );
}

const CLAUDE_COPY_EXCLUDED_TOP_LEVEL_DIRS = new Set(['worktrees']);

export interface CopyClaudeSiviDirsOptions {
  /** 默认覆盖目标文件；恢复快照后可关闭，避免覆盖用户刚还原的配置。 */
  overwriteExisting?: boolean;
}

interface CopyDirOptions extends CopyClaudeSiviDirsOptions {
  /** Top-level children under src that should not be copied. */
  excludeTopLevelDirs?: ReadonlySet<string>;
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

export async function copyClaudeSiviDirs(
  baseRepo: string,
  worktreePath: string,
  options: CopyClaudeSiviDirsOptions = {},
): Promise<void> {
  await copyDirIfExists(path.join(baseRepo, '.claude'), path.join(worktreePath, '.claude'), {
    excludeTopLevelDirs: CLAUDE_COPY_EXCLUDED_TOP_LEVEL_DIRS,
    overwriteExisting: options.overwriteExisting,
  });
  await copyDirIfExists(path.join(baseRepo, '.sivi'), path.join(worktreePath, '.sivi'), options);
}

/**
 * 主入口: 创建一个 worktree 并把元信息写入 store + DB。
 *
 * 串行步骤 (任一失败 → classifyError → 返回 ok:false; 已建半成品需回滚):
 *   1. detectCwd 校验(isGitRepo / gitInstalled / !isInsideWorktree)
 *   2. listBranches 校验 sourceBranch 存在
 *   3. 计算 path = baseRepo/.cindy-worktrees/<name>; 已存在 → 重新 avoidCollision 拿一个
 *   4. mkdirp parent
 *   5. git worktree add -b xdt/<name> <path> <sourceBranch>
 *      失败时若 stderr 含 core.longpaths → 自动 git config --global core.longpaths true 重试一次
 *   6. configureHooksPath
 *   7. copyClaudeSiviDirs(跳过 .claude/worktrees 这类历史工作区状态)
 *   8. applyWorktreeIncludeFile
 *   9. git config --global --add safe.directory <path>
 *  10. worktreeStore.set(sessionId, meta) → 同步写 sessions.worktree_path
 */
export async function createWorktree(
  req: CreateWorktreeReq,
): Promise<CreateWorktreeResp> {
  return withCreateWorktreeQueue(req.baseRepo, () => createWorktreeInner(req));
}

async function createWorktreeInner(
  req: CreateWorktreeReq,
): Promise<CreateWorktreeResp> {
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

    // 1. detect
    const cwdInfo = await timed('detect cwd', () => detectCwd(req.baseRepo));
    if (!cwdInfo.gitInstalled) {
      return { ok: false, error: classifyError({ cause: { code: 'ENOENT', syscall: 'spawn git' } }) };
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
    let name = req.name;
    // 显式 collision: 用户给的 name 与已用冲突 → avoidCollision 加后缀
    if (taken.includes(name)) {
      name = avoidCollision(name, taken);
    }
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
    const addArgs = ['-c', 'core.longpaths=true', 'worktree', 'add', '--no-checkout', '-b', branch, worktreePath, req.sourceBranch];
    try {
      await timed('git worktree add', () => gitExec(addArgs, baseRepo));
    } catch (err) {
      if (
        err instanceof GitExecError &&
        /filename too long|core\.longpaths/i.test(err.stderr)
      ) {
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
      const stageRes = await timed('stage checkout', () => stageCheckout(worktreePath, baseRepo));
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
      const results = await timed('apply include file', () => applyWorktreeIncludeFile(baseRepo, worktreePath));
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
      await timed('add safe.directory', () => gitExec(['config', '--global', '--add', 'safe.directory', worktreePath]));
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
  try {
    await fs.access(meta.path);
  } catch {
    return { hasWorktree: false, dirty: false };
  }
  return { hasWorktree: true, dirty: await isWorktreeDirty(meta.path) };
}

// ── removeWorktreeForSession (无 IPC, 仅会话显式删除/归档路径调) ─────────────

const removeWorktreeQueues = new Map<string, Promise<void>>();

export interface RemoveWorktreeOptions {
  /** destructive remove 前确认 owning session 仍处于允许回收的状态。 */
  canRemove?: () => Promise<boolean>;
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
  const meta = store.get(sessionId);
  if (!meta) return;

  // 哨兵守卫: 用户放了 .worktree-keep ⇒ 无条件保留(必须在 dirty/stash 之前——
  // 哨兵是 untracked 文件,走到 stash 会连哨兵一起收走再删目录)。
  if (hasKeepSentinel(meta.path)) {
    log.info(`[worktree] preserved worktree at ${meta.path}: has ${'.worktree-keep'} sentinel`);
    return;
  }

  // live-ref 守卫: worktree 路径仍被其它未删除会话的 workingDir / worktreePath
  // 指向时不删(典型: 用户在该目录另开了会话)。查询失败按"在用"保守处理。
  const liveKeys = await loadLiveSessionPathKeys({
    contextPath: meta.path,
    excludeSessionId: sessionId,
  });
  if (hasLiveSessionReference(meta, liveKeys)) {
    log.info(
      `[worktree] preserved worktree at ${meta.path}: still referenced by another live session`,
    );
    return;
  }

  let changedIncludeFiles: Awaited<ReturnType<typeof listChangedWorktreeIncludeFiles>>;
  try {
    changedIncludeFiles = await listChangedWorktreeIncludeFiles(meta.baseRepo, meta.path);
  } catch (err) {
    log.warn(
      `[worktree] preserve worktree at ${meta.path}: include-file dirty check failed`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (changedIncludeFiles.length > 0) {
    log.warn(
      `[worktree] preserved worktree at ${meta.path}: changed included local files`,
      changedIncludeFiles.slice(0, 10).map((f) => `${f.relpath}:${f.reason}`),
    );
    return;
  }

  if (!(await canRemoveWorktree(options, meta.path, sessionId))) return;

  const finishRemoval = async (snapshotted: boolean): Promise<void> => {
    if (snapshotted) {
      // The shared mutation lock is already installed before auto-stash starts. Unregister only
      // after the snapshot is durable so SEND waits throughout the clean-worktree window.
      store.del(sessionId);
    }

    // closeSession / snapshot 期间会话可能已恢复为 active。真正删除前再读一次状态；
    // 若本轮已经 snapshot，则把内容重新 apply 回保留目录。
    if (!(await canRemoveWorktree(options, meta.path, sessionId))) {
      if (snapshotted) {
        if (await restoreAutoStashToPreservedWorktree(meta.path, sessionId)) {
          await store.set(sessionId, meta);
        } else {
          log.warn(
            `[worktree] recycle cancelled for ${meta.path}, but snapshot reapply failed; `
            + 'worktree stays unregistered so SEND remains blocked until restore succeeds',
          );
        }
      }
      return;
    }

    let removedByGit = false;
    try {
      await gitExec(['worktree', 'remove', '--force', meta.path], meta.baseRepo);
      removedByGit = true;
    } catch (err) {
      log.warn(
        `[worktree] git worktree remove failed for ${meta.path}:`,
        err instanceof Error ? err.message : String(err),
      );
      // fallback: fs.rm —— 必须三条校验通过
      if (isManagedWorktreePath(meta.path, meta.baseRepo, [...store.getAllPaths(), meta.path])) {
        try {
          await fs.rm(meta.path, { recursive: true, force: true });
          // 让 git worktree 状态自洽
          try {
            await gitExec(['worktree', 'prune'], meta.baseRepo);
          } catch {
            /* prune 失败无影响 */
          }
          removedByGit = true; // 视为已清, 走 store.del
        } catch (rmErr) {
          log.error(
            `[worktree] fs.rm fallback failed for ${meta.path}:`,
            rmErr instanceof Error ? rmErr.message : String(rmErr),
          );
          // 不动 store, 留给用户手动清理或下次启动复用
        }
      } else {
        log.warn(
          `[worktree] isManagedWorktreePath check failed for ${meta.path}; refusing fs.rm`,
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
          `[worktree] remove failed for ${meta.path}, and snapshot reapply also failed; `
          + 'worktree stays unregistered until restore succeeds',
        );
      }
    }
  };

  if (await isWorktreeDirty(meta.path)) {
    await withWorktreeRestoreMutation(sessionId, async () => {
      if (!(await autoStashDirtyWorktree(meta.path, sessionId))) {
        log.warn(
          `[worktree] worktree at ${meta.path} has uncommitted changes, preserving`,
        );
        return;
      }
      await finishRemoval(true);
    });
    return;
  }
  await finishRemoval(false);
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
