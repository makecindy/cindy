/**
 * ghCliTokenSource — 从本地 GitHub CLI(gh)登录态读取 token 的零配置来源。
 *
 * 动机:绝大多数开发者本机已 `gh auth login` 过,不该强迫再去设置页手填 PAT。
 * GitHub 插件网络层优先读取本来源，不可用时再回落设置页 PAT；其它宿主
 * GitHub 功能可直接复用同一个共享 token source。
 *
 * 实现要点:
 *   - `gh auth token` 输出当前登录 token(通常 gho_ 前缀 OAuth token),
 *     对 REST 只读查询(PR 状态)权限足够。
 *   - 共享来源优先使用 Cindy 受管安装，其次系统目录及 ~/.local/bin，最后走 PATH。
 *   - 正缓存默认 5 min，负缓存默认 30s；内置登录完成时主动 invalidate，
 *     并隔离登录前的在途读取，不需要重启或等待 TTL。
 *     没有缓存的话每次徽标刷新都会 spawn 一次 gh。
 *   - 依赖注入(execFile / exists / platform / now),单测零子进程。
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

import { createLogger } from '../logger.js';
import { resolveGhBinary as resolveSharedGhBinary, systemGhBinary } from './ghBinary.js';

const log = createLogger('git-context/gh-cli');
// Check the active credential without the newer auth status --active flag.
// --silent discards the account response; callers only consume the exit code.
export const GH_AUTH_CHECK_ARGS = ['api', '--hostname', 'github.com', 'user', '--silent'];

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 3_000;
const GH_PROBE_TIMEOUT_MS = 800;

export interface GhCliTokenSourceDeps {
  resolveBinary?: () => Promise<string>;
  execFileFn?: (
    file: string,
    args: string[],
    opts: { timeout: number },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  /** 未拿到 token(未安装/未登录)时的缓存时长,默认 30s。 */
  negativeCacheTtlMs?: number;
  now?: () => number;
}

/**
 * 拿不到 token 的原因。UI 按它决定引导动作:
 *   gh-missing        = 二进制不存在(ENOENT / spawn 抛错)→ 引导安装
 *   gh-not-logged-in  = gh 在但 `auth token` 非零退出或输出为空 → 引导登录
 *   gh-timeout        = 子进程超时 → 用户做不了什么,当瞬时失败
 *   gh-exec-failed    = 文件在但跑不起来(EACCES / ENOEXEC 等)→ 同超时,不引导
 */
export type GhCliTokenUnavailableReason =
  'gh-missing' | 'gh-not-logged-in' | 'gh-timeout' | 'gh-exec-failed';

export type GhCliTokenReadResult =
  { ok: true; token: string } | { ok: false; reason: GhCliTokenUnavailableReason };

export interface GhCliTokenSource {
  invalidate(): void;
  /** 返回本地 gh 登录 token;未安装 / 未登录 / 超时返回 null,永不抛错。 */
  readToken(): Promise<string | null>;
  /** 同 readToken,但保留拿不到 token 的原因(共享同一份缓存)。永不抛错。 */
  readTokenDetailed(): Promise<GhCliTokenReadResult>;
  /** 只探测 github.com 登录可用性，不读取或缓存 token。 */
  probeAvailability(): Promise<boolean>;
}

/**
 * execFile 回调 err 的分类。
 * Node:子进程非零退出时 `code` 是数字;spawn/exec 失败时 `code` 是字符串
 * (ENOENT / EACCES / ENOEXEC …)。只有真正跑起来再失败才算未登录。
 */
function classifyExecError(err: Error): GhCliTokenUnavailableReason {
  const e = err as Error & { code?: unknown; killed?: boolean; signal?: unknown };
  if (e.code === 'ENOENT') return 'gh-missing';
  if (e.killed && typeof e.signal === 'string') return 'gh-timeout';
  if (typeof e.code === 'string') return 'gh-exec-failed';
  return 'gh-not-logged-in';
}

export function createGhCliTokenSource(deps: GhCliTokenSourceDeps = {}): GhCliTokenSource {
  const execFileFn = deps.execFileFn ?? execFile;
  const existsFn = deps.existsFn ?? fs.existsSync;
  const platform = deps.platform ?? process.platform;
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const negativeTtl = deps.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  let cached: { result: GhCliTokenReadResult; expiresAt: number } | null = null;
  let inFlight: Promise<GhCliTokenReadResult> | null = null;
  let generation = 0;

  function resolveGhBinary(): string {
    return systemGhBinary(platform, existsFn);
  }

  async function fetchToken(): Promise<GhCliTokenReadResult> {
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    return new Promise<GhCliTokenReadResult>((resolve) => {
      try {
        execFileFn(
          bin,
          ['auth', 'token', '--hostname', 'github.com'],
          { timeout: GH_TIMEOUT_MS },
          (err, stdout) => {
            if (err) {
              // 失败只 debug 级记录;原因分类留给 UI 决定引导动作。
              const reason = classifyExecError(err);
              log.debug('gh auth token unavailable', { reason });
              resolve({ ok: false, reason });
              return;
            }
            const token = stdout.trim();
            resolve(
              token.length > 0 ? { ok: true, token } : { ok: false, reason: 'gh-not-logged-in' },
            );
          },
        );
      } catch (err) {
        log.debug('gh spawn threw', { err: String(err) });
        resolve({ ok: false, reason: 'gh-missing' });
      }
    });
  }

  async function readTokenDetailed(): Promise<GhCliTokenReadResult> {
    if (cached && cached.expiresAt > now()) return cached.result;
    if (inFlight) return inFlight;
    const gen = generation;
    inFlight = fetchToken()
      .then((result) => {
        if (gen === generation) {
          cached = { result, expiresAt: now() + (result.ok ? ttl : negativeTtl) };
        }
        return result;
      })
      .finally(() => {
        if (gen === generation) inFlight = null;
      });
    return inFlight;
  }

  async function probeAvailability(): Promise<boolean> {
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    return new Promise<boolean>((resolve) => {
      try {
        // stdout/stderr 都不进入日志；该调用只消费退出码，绝不取得 token。
        execFileFn(
          bin,
          GH_AUTH_CHECK_ARGS,
          { timeout: GH_PROBE_TIMEOUT_MS },
          (err) => resolve(err === null),
        );
      } catch {
        resolve(false);
      }
    });
  }

  return {
    invalidate() {
      generation += 1;
      cached = null;
      inFlight = null;
    },
    probeAvailability,
    readTokenDetailed,
    async readToken(): Promise<string | null> {
      const result = await readTokenDetailed();
      return result.ok ? result.token : null;
    },
  };
}

let sharedSource: GhCliTokenSource | null = null;

/**
 * 进程内共享实例。多个消费方(PR 状态徽标、「我的 Issue」列表)各自 new 一份的话,
 * 缓存互不可见 —— 同一段时间会重复 spawn `gh`,负缓存也各算一套。
 */
export function getSharedGhCliTokenSource(): GhCliTokenSource {
  if (!sharedSource)
    sharedSource = createGhCliTokenSource({ resolveBinary: resolveSharedGhBinary });
  return sharedSource;
}
