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
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Windows 上凭据管理器可能尝试弹 UI；与 TERMINAL_PROMPT 一起双保险。
          GCM_INTERACTIVE: 'never',
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
 * 把原始 git 输出整理成可以回传 Renderer 的详情：只保留 stderr（execFile 的
 * message 前缀含完整命令行与内部 staging 路径）、抹掉残留的内部路径与 URL
 * 内嵌凭证。完整原文仍留在 main 日志（调用方记录）。
 */
function sanitizeGitDetail(error: unknown, internalPaths: readonly string[]): string {
  const raw =
    error && typeof error === 'object' && 'stderr' in error && (error as { stderr?: unknown }).stderr
      ? String((error as { stderr?: unknown }).stderr)
      : errorText(error);
  let text = raw;
  for (const internalPath of internalPaths) {
    text = text.split(internalPath).join('<marketplace>');
  }
  // URL 内嵌凭证（https://user:pass@host）不进 Renderer。
  text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@');
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
 * 克隆市场仓库到 destPath（staging + rename 原子替换；Windows 不允许 rename
 * 覆盖非空目录，因此调用方需保证 destPath 不存在或先移除）。
 */
export async function cloneMarketplace(
  input: { url: string; ref?: string; sparsePaths: readonly string[] },
  destPath: string,
  executor: GitExecutor = defaultExecutor,
): Promise<string> {
  const stagingPath = `${destPath}.staging-${crypto.randomUUID()}`;
  const timeoutMs = GIT_OPERATION_TIMEOUT_MS;
  try {
    if (input.sparsePaths.length === 0) {
      const args = ['clone'];
      if (input.ref) args.push('--branch', input.ref);
      args.push(input.url, stagingPath);
      await executor(args, { timeoutMs });
    } else {
      await executor(
        ['clone', '--filter=blob:none', '--no-checkout', input.url, stagingPath],
        { timeoutMs },
      );
      await executor(['sparse-checkout', 'set', ...input.sparsePaths], {
        cwd: stagingPath,
        timeoutMs,
      });
      await executor(['checkout', input.ref ?? 'HEAD'], { cwd: stagingPath, timeoutMs });
    }
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.rename(stagingPath, destPath);
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
): Promise<string> {
  const timeoutMs = GIT_OPERATION_TIMEOUT_MS;
  try {
    if (ref) {
      // 显式引用：对齐远端该 ref（branch/tag/commit 统一用 FETCH_HEAD 落位）。
      await executor(['fetch', 'origin', ref], { cwd: marketPath, timeoutMs });
      await executor(['reset', '--hard', 'FETCH_HEAD'], { cwd: marketPath, timeoutMs });
    } else {
      await executor(['pull', '--ff-only'], { cwd: marketPath, timeoutMs });
    }
    return await currentRevision(marketPath, executor);
  } catch (error) {
    throw classifyGitFailure(error, [marketPath]);
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
