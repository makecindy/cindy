/**
 * 自定义市场的 Git 操作。
 *
 * 与 Codex 同一策略：私有仓库认证完全交给用户系统级 Git 配置
 * （credential helper / SSH agent / gh auth），客户端不做任何特殊处理。
 * 唯一的强约束是 GIT_TERMINAL_PROMPT=0 —— Electron 主进程没有 TTY，
 * 缺少凭证的克隆必须立即失败并分类引导，绝不能挂在隐形的密码提示上。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { IpcErrorCode } from '../../../shared/ipc-errors.js';

/** 克隆/拉取超时：大仓库给足窗口，但绝不无限挂起。 */
const GIT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

/** rename 遇 Windows 瞬时锁(AV/索引器/云同步持句柄)短退避重试;其余立即上抛。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const transient = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= 3 || !code || !transient.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
/** sparse-checkout 需要 Git >= 2.25。 */
export const MIN_GIT_VERSION = { major: 2, minor: 25 } as const;

/** 带 IPC 错误码的市场 Git 失败；service 层原样转成 throwIpcError。 */
export class MarketGitError extends Error {
  constructor(
    readonly code: Extract<
      IpcErrorCode,
      | 'MARKET_GIT_UNAVAILABLE'
      | 'MARKET_CLONE_AUTH_FAILED'
      | 'MARKET_CLONE_FAILED'
      | 'MARKET_REF_NOT_FOUND'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'MarketGitError';
  }
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/** 可注入的 git 执行器：单测用 fake，生产走 execFile。 */
export type GitExecutor = (
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<GitExecResult>;

const defaultExecutor: GitExecutor = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      // 缓存路径(owners/<hex>/plugin-market/sources/<slug>/incoming/…)在
      // Windows 上极易越过 MAX_PATH 260,不带 longpaths 时 clone/checkout 报
      // "Filename too long"。统一在执行器注入,非 Windows 平台 git 会忽略。
      ['-c', 'core.longpaths=true', ...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // Windows 上不闪控制台窗口(一次 addSource 要跑 5-6 条 git 命令)。
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Windows 上凭据管理器可能尝试弹 UI；与 TERMINAL_PROMPT 一起双保险。
          GCM_INTERACTIVE: 'never',
          // askpass helper(VSCode 注入的 GIT_ASKPASS、桌面环境的 SSH_ASKPASS)
          // 会弹 GUI 输入框,Electron main 没人去点,只能挂满 5 分钟超时。
          // 置空让 git 直接失败并落到 stderr 分类。
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          // 强制英文报错：classifyGitFailure 按英文文案分类，本地化 git
          // 输出（如中文 "无法读取远程仓库"）会让分类失效、误导引导文案。
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    return `${message}\n${stderr}`;
  }
  return String(error);
}

/**
 * 抹掉任意绝对路径。git 自己的输出之外，OpenSSH、credential helper、杀毒钩子都会
 * 往 stderr 写宿主路径（`/Users/<name>/.ssh/id_rsa`、`C:\Users\<name>\...`、
 * `~/.gitconfig`），只替换已知的缓存路径盖不住这些 —— 用户名与宿主目录结构不该
 * 经 IPC 到达 Renderer。诊断用的完整原文仍在 main 日志里。
 *
 * 导出给 discover 等其它会把错误详情转发 Renderer 的模块共用:任何进 IPC 错误
 * detail 的系统错误 message(realpath/readFile 的 ENOENT/EACCES 自带完整路径)
 * 都必须先过这一遍。
 */
export function redactAbsolutePaths(text: string): string {
  // 先把 URL 摘出来占位:仓库地址是用户自己输入的、要留着给他定位问题,不能被
  // 下面的路径规则把 `https://host/org/repo.git` 的路径段一起抹掉。
  const urls: string[] = [];
  const masked = text.replace(/\b(?:https?|ssh|git):\/\/[^\s"'<>|]+/gi, (match) => {
    urls.push(match);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  return (
    masked
      // Windows：C:\Users\name\... / \\server\share\...
      .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, '<path>')
      .replace(/\\\\[^\s"'<>|]+/g, '<path>')
      // POSIX：`/home/alice`、`/tmp/foo` 这类两段路径同样带用户名与目录结构,
      // 必须一起覆盖(此前要求两个带斜杠的段,实际只盖到三段及以上)。
      .replace(/\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/g, '<path>')
      // ~ 开头的家目录相对路径
      .replace(/~\/[^\s"'<>|]*/g, '<path>')
      // 还原 URL 时抹掉整个 userinfo:`https://ghp_TOKEN@host/...` 这类单段
      // 凭证没有冒号,user:pass 规则盖不住;host 与路径保留给用户定位问题。
      .replace(/\u0000URL(\d+)\u0000/g, (_, index: string) => {
        const url = urls[Number(index)];
        if (url === undefined) return '<path>';
        return url.replace(/^((?:https?|ssh|git):\/\/)[^/@\s]+@/i, '$1***@');
      })
  );
}

/**
 * 把原始 git 输出整理成可以回传 Renderer 的详情：只保留 stderr（execFile 的
 * message 前缀含完整命令行与内部 staging 路径）、抹掉 URL 内嵌凭证与任意绝对
 * 路径。完整原文仍留在 main 日志（调用方记录）。
 */
function sanitizeGitDetail(error: unknown, internalPaths: readonly string[]): string {
  const raw =
    error && typeof error === 'object' && 'stderr' in error && (error as { stderr?: unknown }).stderr
      ? String((error as { stderr?: unknown }).stderr)
      : errorText(error);
  let text = raw;
  // 已知的内部缓存路径换成有意义的占位符（比统一的 <path> 更可读）。
  for (const internalPath of internalPaths) {
    text = text.split(internalPath).join('<marketplace>');
  }
  // URL 内嵌凭证不进 Renderer:user:pass 与单段 token(https://ghp_x@host,
  // 常见于 ~/.gitconfig 的 insteadOf 重写)都要盖住。
  text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@');
  text = text.replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, '$1***@');
  // 兜住其余任意绝对路径（SSH identity file、credential helper、杀毒钩子等）。
  text = redactAbsolutePaths(text);
  // git stderr 会回显远端提供的文案(remote: …),自建服务可塞双向控制符做
  // 错误区文案欺骗;与市场名同一口径剥掉(保留换行/制表便于阅读)。
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  return text.trim().slice(0, 512);
}

/** 把 git 失败分类成可引导的 IPC 错误码；message 是经消毒、可展示给用户的详情。 */
export function classifyGitFailure(
  error: unknown,
  internalPaths: readonly string[] = [],
): MarketGitError {
  const text = errorText(error);
  const detail = sanitizeGitDetail(error, internalPaths);
  if (/Remote branch \S+ not found|Couldn't find remote ref|couldn't find remote ref/i.test(text)) {
    return new MarketGitError('MARKET_REF_NOT_FOUND', detail);
  }
  if (/Authentication failed|could not read Username|Repository not found|Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository|SAML SSO/i.test(text)) {
    return new MarketGitError('MARKET_CLONE_AUTH_FAILED', detail);
  }
  return new MarketGitError('MARKET_CLONE_FAILED', detail);
}

export async function gitVersion(
  executor: GitExecutor = defaultExecutor,
): Promise<{ major: number; minor: number } | null> {
  try {
    const { stdout } = await executor(['--version'], { timeoutMs: 10_000 });
    const match = /git version (\d+)\.(\d+)/.exec(stdout);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return null;
  }
}

export function isGitVersionSupported(version: { major: number; minor: number }): boolean {
  if (version.major !== MIN_GIT_VERSION.major) return version.major > MIN_GIT_VERSION.major;
  return version.minor >= MIN_GIT_VERSION.minor;
}

/**
 * 远端默认分支名(`origin/HEAD` → `main`/`master`/…)。`--no-checkout` 克隆后
 * 拿它来 checkout 一个**真实分支**,保留上游跟踪关系,后续 `pull --ff-only`
 * 才能快进。解析失败返回 null,由调用方决定退路。
 */
async function defaultBranchName(
  cwd: string,
  executor: GitExecutor,
): Promise<string | null> {
  try {
    const { stdout } = await executor(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
      timeoutMs: 10_000,
    });
    // 形如 `origin/main`,取 remote 前缀之后的分支名。
    const value = stdout.trim();
    const slash = value.indexOf('/');
    const branch = slash >= 0 ? value.slice(slash + 1) : value;
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * 克隆市场仓库到 destPath（staging + rename 原子替换；Windows 不允许 rename
 * 覆盖非空目录，因此调用方需保证 destPath 不存在或先移除）。
 */
export async function cloneMarketplace(
  input: { url: string; ref?: string; sparsePaths: readonly string[] },
  destPath: string,
  executor: GitExecutor = defaultExecutor,
  /**
   * 在 git 实际取包的那个仓库（staging 目录）里执行，用来采集实际取包地址（见 fetchIdentity.ts）：
   * `'cloned'` 紧接 `git clone` 之后、显式 checkout 之前；`'checked-out'` 在检出完成、落位之前
   * （`includeIf "gitdir:…"` 与之后刷新的状态）。调用方要求各次采集一致才记下地址。注意 `'cloned'` 时 git
   * 可能已从取包时的初始分支切到远端默认分支，`includeIf "onbranch:…"` 只能靠 hasBranchConditionalConfig 排除。
   */
  inspect?: (repoDir: string, phase: 'cloned' | 'checked-out') => Promise<void>,
): Promise<string> {
  const stagingPath = `${destPath}.staging-${crypto.randomUUID()}`;
  const timeoutMs = GIT_OPERATION_TIMEOUT_MS;
  try {
    if (input.sparsePaths.length === 0) {
      await executor(['clone', input.url, stagingPath], { timeoutMs });
      await inspect?.(stagingPath, 'cloned');
      if (input.ref) {
        // --branch 只支持 branch/tag;显式 checkout 同时覆盖可达的 commit SHA。
        // 必须带 --detach 消歧:`git checkout <ref>` 在 ref 不存在但仓库根恰有
        // 同名文件时会退化成**路径检出**并成功返回,HEAD 仍停在默认分支——用户
        // pin 住的引用被静默换成默认分支内容。--detach 强制按 commit-ish 解析,
        // 解析不了就如实失败。
        await executor(['checkout', '--detach', input.ref], { cwd: stagingPath, timeoutMs });
      }
    } else {
      await executor(
        ['clone', '--filter=blob:none', '--no-checkout', input.url, stagingPath],
        { timeoutMs },
      );
      await inspect?.(stagingPath, 'cloned');
      // -- 终止选项解析：即使上游漏放了以 - 开头的值,也只被当作路径。
      await executor(['sparse-checkout', 'set', '--', ...input.sparsePaths], {
        cwd: stagingPath,
        timeoutMs,
      });
      // 无显式 ref 时必须 checkout 默认**分支**而不是 `HEAD`:后者留下 detached
      // HEAD,刷新走的 `git pull --ff-only` 会稳定失败并回落到整仓重克隆,
      // 等于每次刷新都重新 clone。取不到默认分支名时才退回 HEAD。
      // 显式 ref 同样带 --detach 消歧(见上:防同名文件把 checkout 变成路径检出)。
      if (input.ref) {
        await executor(['checkout', '--detach', input.ref], { cwd: stagingPath, timeoutMs });
      } else {
        const target = (await defaultBranchName(stagingPath, executor)) ?? 'HEAD';
        await executor(['checkout', target], { cwd: stagingPath, timeoutMs });
      }
    }
    await inspect?.(stagingPath, 'checked-out');
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    // Windows 上 AV/索引器/云同步会短暂占用刚 clone 出的文件,rename 抛
    // EBUSY/EACCES/EPERM;瞬时锁短退避重试。目标是全新 UUID 路径,不存在覆盖。
    await renameWithRetry(stagingPath, destPath);
    return await currentRevision(destPath, executor);
  } catch (error) {
    await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw classifyGitFailure(error, [stagingPath, destPath]);
  }
}

/**
 * 刷新已克隆市场：fetch + 快进到上游。返回新 HEAD SHA。
 * 用户在克隆目录里的本地改动不属于支持场景——市场目录是客户端管理的缓存，
 * 快进失败按刷新失败处理，由调用方决定重克隆。
 */
export async function fetchMarketplace(
  marketPath: string,
  ref: string | undefined,
  executor: GitExecutor = defaultExecutor,
  /** 默认在 marketPath 原地快进；传入 cwd 时在该工作目录执行（刷新 staging 用）。 */
  cwd?: string,
): Promise<string> {
  const workDir = cwd ?? marketPath;
  const timeoutMs = GIT_OPERATION_TIMEOUT_MS;
  try {
    if (ref) {
      // 显式引用：对齐远端该 ref（branch/tag/commit 统一用 FETCH_HEAD 落位）。
      await executor(['fetch', 'origin', ref], { cwd: workDir, timeoutMs });
      await executor(['reset', '--hard', 'FETCH_HEAD'], { cwd: workDir, timeoutMs });
    } else {
      await executor(['pull', '--ff-only'], { cwd: workDir, timeoutMs });
    }
    const revision = await currentRevision(workDir, executor);
    // 检出的 HEAD 必须就是本次获取的目标提交。远端（或 insteadOf 改写到的另一个仓库）停在本地 HEAD 的
    // 祖先时，`pull --ff-only` 也会成功但保留领先的本地 HEAD；那样落位的包并不是这次取到的内容。
    // 对不上就按刷新失败处理，由调用方回落到全新克隆。
    // `^{commit}`：显式 ref 是附注标签时 FETCH_HEAD 指向标签对象，要剥到提交再比。
    const { stdout } = await executor(['rev-parse', '--verify', `${ref ? 'FETCH_HEAD' : '@{u}'}^{commit}`], {
      cwd: workDir,
      timeoutMs: 10_000,
    });
    if (stdout.trim() !== revision) {
      throw new Error('The checked-out commit is not the fetched target');
    }
    return revision;
  } catch (error) {
    throw classifyGitFailure(error, [workDir]);
  }
}

export async function currentRevision(
  marketPath: string,
  executor: GitExecutor = defaultExecutor,
): Promise<string> {
  const { stdout } = await executor(['rev-parse', 'HEAD'], {
    cwd: marketPath,
    timeoutMs: 10_000,
  });
  return stdout.trim();
}

/**
 * 当前配置上下文里有没有按分支生效的条件包含（`includeIf "onbranch:…"`）。`git clone` 在返回前会从初始分支
 * （`init.defaultBranch`）切到远端默认分支或检出目标，这类规则在取包当时与事后可能不同，事后解析还原不了
 * 取包时的上下文；有这类规则时调用方不核实来源。只列键名（不含值），不联网；读不到配置也按「有」处理。
 */
export async function hasBranchConditionalConfig(
  executor: GitExecutor = defaultExecutor,
  cwd?: string,
): Promise<boolean> {
  try {
    const { stdout } = await executor(['config', '--list', '--name-only'], {
      ...(cwd ? { cwd } : {}),
      timeoutMs: 10_000,
    });
    return stdout.split('\n').some((line) => /^includeif\.onbranch:/i.test(line.trim()));
  } catch {
    return true;
  }
}

/**
 * git 实际会连的地址：`ls-remote --get-url` 按当前 git 配置展开 `url.*.insteadOf`，不联网。
 * `target` 是配置里的地址（clone 前）或 `origin`（在已克隆的工作目录里 fetch 前）。
 * 结果可能含改写注入的凭证：只交给白名单生成函数，不得写日志、错误详情或任何文件；失败返回 null。
 */
export async function resolveFetchUrl(
  target: string,
  executor: GitExecutor = defaultExecutor,
  cwd?: string,
): Promise<string | null> {
  try {
    const { stdout } = await executor(['ls-remote', '--get-url', '--', target], {
      ...(cwd ? { cwd } : {}),
      timeoutMs: 10_000,
    });
    const value = stdout.trim();
    return value && !value.includes('\n') ? value : null;
  } catch {
    return null;
  }
}
