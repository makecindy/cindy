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
// --silent discards the account response. Never expose process output.
const GH_AUTH_CHECK_ARGS = ['api', '--hostname', 'github.com', 'user', '--silent'];

/** Host account flows use gh's saved login, never a terminal token override. */
export function ghAccountEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['GH_TOKEN', 'GITHUB_TOKEN'].includes(key.toUpperCase()),
    ),
  );
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 3_000;
const GH_PROBE_TIMEOUT_MS = 15_000;

export interface GhCliTokenSourceDeps {
  resolveBinary?: () => Promise<string>;
  execFileFn?: (
    file: string,
    args: string[],
    opts: { timeout: number; env: NodeJS.ProcessEnv; windowsHide?: boolean },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  /** 未拿到 token(未安装/未登录)时的缓存时长,默认 30s。 */
  negativeCacheTtlMs?: number;
  now?: () => number;
}

/** Only an absent login or a rejected credential is a reason to authorize again. */
export function checkGhAccount(
  binary: string,
  run: NonNullable<GhCliTokenSourceDeps['execFileFn']> = execFile,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    run(binary, GH_AUTH_CHECK_ARGS, { timeout: GH_PROBE_TIMEOUT_MS, env: ghAccountEnv(), windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve(true);
        const { code, killed } = error as Error & { code?: string | number; killed?: boolean };
        if (!killed && (code === 4 || code === 'ENOENT' || /\(HTTP 401\)/.test(stderr))) return resolve(false);
        reject(new Error('network'));
      });
  });
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
  /** 本机登录 github.com 的账号(活跃账号在前);`null` 表示探测没做成。永不抛错。 */
  listLogins(): Promise<string[] | null>;
  /** 指定账号的 token(不是活跃账号也不切换);拿不到返回 null。永不抛错。 */
  readTokenForLogin(login: string): Promise<string | null>;
}

/** GitHub 登录名;`gh auth status --json` 的输出只按这个形状采信。 */
const LOGIN_RE = /^[a-zA-Z0-9-]{1,39}$/;

function parseLogins(stdout: string): string[] {
  try {
    const hosts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> }).hosts?.['github.com'];
    if (!Array.isArray(hosts)) return [];
    return hosts.flatMap((entry) => {
      const { login, state } = (entry ?? {}) as { login?: unknown; state?: unknown };
      return state === 'success' && typeof login === 'string' && LOGIN_RE.test(login) ? [login] : [];
    });
  } catch {
    return [];
  }
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
  // 多账号只服务「这个仓库该用哪个账号」的分支(见 repoAccountResolver),活跃账号仍是默认。
  let loginsCache: { logins: string[] | null; expiresAt: number } | null = null;
  let loginsInFlight: Promise<string[] | null> | null = null;
  const loginTokens = new Map<string, { token: string; expiresAt: number }>();
  const loginTokenInFlight = new Map<string, Promise<string | null>>();

  function resolveGhBinary(): string {
    return systemGhBinary(platform, existsFn);
  }

  async function fetchToken(): Promise<GhCliTokenReadResult> {
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    return new Promise<GhCliTokenReadResult>((resolve) => {
      try {
        // All consumers target public GitHub, regardless of GH_HOST or CLI defaults.
        execFileFn(
          bin,
          ['auth', 'token', '--hostname', 'github.com'],
          { timeout: GH_TIMEOUT_MS, env: ghAccountEnv() },
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

  async function readLogins(): Promise<string[] | null> {
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    return new Promise<string[] | null>((resolve) => {
      try {
        // `--json` 不吐 token,并在有账号鉴权异常时仍以 0 退出;逐个账号读钥匙串约 1s。
        execFileFn(
          bin,
          ['auth', 'status', '--json', 'hosts', '--hostname', 'github.com'],
          { timeout: GH_PROBE_TIMEOUT_MS, env: ghAccountEnv(), windowsHide: true },
          // 非零退出只说明这次探测没做成(超时、spawn 失败、CLI 自身报错),
          // 不能当成「本机没有备用账号」——那会让仓库被记成读不到。
          (err, stdout) => resolve(err ? null : parseLogins(stdout)),
        );
      } catch {
        resolve(null);
      }
    });
  }

  // 一次批量刷新可能同时遇到多个仓库的恢复探测,账号列表和每个账号的 token 都要合并在途读取,
  // 否则同一轮会重复 spawn gh、重复读钥匙串。
  async function listLogins(): Promise<string[] | null> {
    if (loginsCache && loginsCache.expiresAt > now()) return loginsCache.logins;
    if (loginsInFlight) return loginsInFlight;
    const gen = generation;
    loginsInFlight = readLogins()
      .then((logins) => {
        // 登录态变过就丢掉:那可能是旧账号列表。
        if (gen === generation)
          loginsCache = {
            logins,
            // 探测失败只短记,避免一次 CLI 卡顿锁住十分钟的失败记忆。
            expiresAt: now() + (logins && logins.length > 0 ? ttl : negativeTtl),
          };
        return logins;
      })
      .finally(() => {
        if (gen === generation) loginsInFlight = null;
      });
    return loginsInFlight;
  }

  async function requestLoginToken(login: string): Promise<string | null> {
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    return new Promise<string | null>((resolve) => {
      try {
        execFileFn(
          bin,
          ['auth', 'token', '--hostname', 'github.com', '--user', login],
          { timeout: GH_TIMEOUT_MS, env: ghAccountEnv(), windowsHide: true },
          (err, stdout) => {
            // 登出 / 没过期的 token 都只是「这个账号用不了」,不升级成登录引导。
            const token = err ? '' : stdout.trim();
            resolve(token.length > 0 ? token : null);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  async function readTokenForLogin(login: string): Promise<string | null> {
    const hit = loginTokens.get(login);
    if (hit && hit.expiresAt > now()) return hit.token;
    const inflight = loginTokenInFlight.get(login);
    if (inflight) return inflight;
    const gen = generation;
    const p = requestLoginToken(login)
      .then((token) => {
        if (gen !== generation) return token;
        if (token) loginTokens.set(login, { token, expiresAt: now() + ttl });
        else loginTokens.delete(login);
        return token;
      })
      .finally(() => {
        if (loginTokenInFlight.get(login) === p) loginTokenInFlight.delete(login);
      });
    loginTokenInFlight.set(login, p);
    return p;
  }

  // The legacy settings contract exposes a boolean. A transient failure can reuse
  // a recent confirmation for display only; authorization never consults this value.
  let lastConfirmedUntil = 0;
  let probeGeneration = 0;
  async function probeAvailability(): Promise<boolean> {
    const request = ++probeGeneration;
    const bin = deps.resolveBinary ? await deps.resolveBinary() : resolveGhBinary();
    try {
      const available = await checkGhAccount(bin, execFileFn);
      if (request === probeGeneration) lastConfirmedUntil = available ? now() + ttl : 0;
      return available;
    } catch {
      return now() < lastConfirmedUntil;
    }
  }

  return {
    invalidate() {
      generation += 1;
      probeGeneration++;
      lastConfirmedUntil = 0;
      cached = null;
      inFlight = null;
      loginsCache = null;
      loginsInFlight = null;
      loginTokens.clear();
      loginTokenInFlight.clear();
    },
    listLogins,
    probeAvailability,
    readTokenDetailed,
    readTokenForLogin,
    async readToken(): Promise<string | null> {
      const result = await readTokenDetailed();
      return result.ok ? result.token : null;
    },
  };
}

let sharedSource: GhCliTokenSource | null = null;

export function invalidateSharedGhCliTokenSource(): void {
  sharedSource = null;
}

/**
 * 进程内共享实例。多个消费方(PR 状态徽标、「我的 Issue」列表)各自 new 一份的话,
 * 缓存互不可见 —— 同一段时间会重复 spawn `gh`,负缓存也各算一套。
 */
export function getSharedGhCliTokenSource(): GhCliTokenSource {
  if (!sharedSource)
    sharedSource = createGhCliTokenSource({ resolveBinary: resolveSharedGhBinary });
  return sharedSource;
}
