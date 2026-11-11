import { spawn, type ChildProcess } from 'node:child_process';

import { cleanProcessEnv } from '@cindy/maker-core';
import { hasProxyEnvConfig, parseOutboundProxyUrl } from '@cindy/anthropic-compat-proxy';

import { createLogger } from '../logger.js';
import { ensureClaudeCliProxyBridge } from './claude-cli-proxy-bridge.js';
import {
  isClaudeCliLoginStatusFresh,
  peekClaudeCliLoginStatus,
  publishClaudeCliLoginStatus,
  resetClaudeCliLoginStatusForTest,
  setClaudeCliLoginStatusListenerErrorHandler,
  type ClaudeCliLoginStatus,
} from './claude-native-cli-status.js';

export {
  onClaudeCliLoginStatusChange,
  peekClaudeCliLoginStatus,
  type ClaudeCliLoginStatus,
} from './claude-native-cli-status.js';


export interface ClaudeCliPlanUsage {
  /** `get_usage` 响应的 `rate_limits`(与 claude.ai /usage 同形,由 shared 解析器 fail-safe 解析)。 */
  rateLimits: unknown;
  subscriptionType?: string;
}

export type ClaudeCliLoginResult =
  | { ok: true; status: ClaudeCliLoginStatus }
  | {
      ok: false;
      reason: 'login_cancelled' | 'timeout' | 'local_unavailable' | 'login_failed' | 'not_a_subscription';
    };
/** Shared official CLI lifecycle; launchers supply binary discovery and status IO. */
export function createClaudeNativeCli(ports: {
  binaryPath(): string | null;
  resolveOutboundProxy(url: string): string | null | undefined | Promise<string | null | undefined>;
  readStatus(options: { binary: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ClaudeCliLoginStatus | null>;
}) {
const log = createLogger('claude-native-cli');
setClaudeCliLoginStatusListenerErrorHandler((err) => {
  log.warn('claude cli status listener failed', { error: String(err) });
});

const STATUS_TIMEOUT_MS = 10_000;
/** 读登录态失败(CLI 未就绪 / 超时 / 输出异常)后,这段时间内不再重复拉起 CLI。 */
const STATUS_FAILURE_BACKOFF_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * 让 CLI 走用户的代理。CLI 只认 HTTPS_PROXY 环境变量、不读系统代理 / PAC,也不支持
 * SOCKS;GUI 启动的 Cindy 拿不到 shell env,开「系统代理」模式的用户直连会失败。
 * 出口按与本地 proxy 相同的规则解析(代理 env 优先,其次系统代理 / PAC):
 *   - Anthropic 直连 / 解析失败:不下发,CLI 进程树的环境保持原样;
 *   - 代理 env 给的 HTTP 代理:不动(子进程继承,保留用户自己的 NO_PROXY 语义);
 *   - 系统代理,或代理 env 给的 SOCKS5:HTTPS_PROXY 指向本机 CONNECT 桥
 *     (claude-cli-proxy-bridge)。环境变量对整棵进程树生效(含 Bash 工具里的 git / npm),
 *     所以桥对每个目标重新按系统代理 / PAC 决定直连还是走代理,内网例外照旧直连;
 *     明文 HTTP 不下发代理,保持直连。
 * 用户在 ~/.claude/settings.json 的 env 里配的代理由 CLI 自己应用,优先于这里。
 * HTTPS 经代理走 CONNECT 隧道,TLS 端到端,代理、桥与 Cindy 都看不到凭证。
 */
async function claudeCliNetworkEnv(): Promise<Record<string, string>> {
  const fromEnv = hasProxyEnvConfig();
  let raw: string | null | undefined = null;
  try {
    raw = await ports.resolveOutboundProxy(ANTHROPIC_API_ORIGIN);
  } catch (err) {
    log.debug('proxy resolution failed; CLI connects directly', {
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  const target = parseOutboundProxyUrl(raw);
  if (!raw || !target) return {};
  if (fromEnv && target.kind === 'http') return {};
  let bridge: string;
  try {
    bridge = await ensureClaudeCliProxyBridge(ports.resolveOutboundProxy);
  } catch {
    return {};
  }
  const noProxy: Record<string, string> = fromEnv ? {} : { NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY };
  return { HTTPS_PROXY: bridge, https_proxy: bridge, ...noProxy };
}

function cliBinaryPath(): string | null {
  return ports.binaryPath();
}

/**
 * 默认账号不设配置目录，继续共用终端的凭证库。显式的额外账号只为本次 CLI
 * 子进程设置目录；process.env 的 CLAUDE_CONFIG_DIR 在 boot 期已被剥离。
 */
async function cliEnv(options: { network: boolean; configDir?: string }): Promise<NodeJS.ProcessEnv> {
  return {
    ...cleanProcessEnv(),
    ...(options.network ? await claudeCliNetworkEnv() : {}),
    ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
  };
}

function runCli(
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string; reason?: 'timeout' | 'cancelled' }> {
  const binary = cliBinaryPath();
  if (!binary) return Promise.reject(new Error('claude cli unavailable'));
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let reason: 'timeout' | 'cancelled' | undefined;
    const stop = (why: 'timeout' | 'cancelled') => {
      if (reason) return;
      reason = why;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('cancelled');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, ...(reason ? { reason } : {}) });
    });
  });
}

/** Local display helper for usage payloads; status parsing lives in maker-core. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}



// ── 登录态 ────────────────────────────────────────────────────────────────────

let statusInflight: Promise<ClaudeCliLoginStatus> | null = null;
let lastStatusFailureAt: number | null = null;
// Each official CLI profile owns its status and in-flight read. Never publish a
// secondary account as the default CLI login used by discovery.
const profileStatuses = new Map<string, { value?: ClaudeCliLoginStatus; at: number; flight?: Promise<ClaudeCliLoginStatus> }>();

function readProfileStatus(configDir: string, force = false): Promise<ClaudeCliLoginStatus> {
  const entry = profileStatuses.get(configDir) ?? { at: 0 };
  profileStatuses.set(configDir, entry);
  if (entry.flight) return entry.flight;
  if (!force && entry.value && Date.now() - entry.at < STATUS_FAILURE_BACKOFF_MS) return Promise.resolve(entry.value);
  const flight = (async () => {
    const binary = cliBinaryPath();
    if (!binary) throw new Error('claude cli unavailable');
    const status = await ports.readStatus({
      binary, env: await cliEnv({ network: false, configDir }), timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (!status) throw new Error('claude auth status unavailable');
    entry.value = status;
    entry.at = Date.now();
    return status;
  })();
  entry.flight = flight;
  void flight.finally(() => { if (entry.flight === flight) entry.flight = undefined; }).catch(() => {});
  return flight;
}

function statusFallback(): ClaudeCliLoginStatus {
  return peekClaudeCliLoginStatus() ?? { loggedIn: false };
}

/**
 * 读 CLI 登录态(`claude auth status --json`,约 0.1–0.3s)。同一时刻只跑一个;
 * 读失败(超时 / 输出异常 / 拉起失败)时保留上一次结果,从未读到过则视为未登录,
 * 并在 STATUS_FAILURE_BACKOFF_MS 内不再重试(force 除外,如用户主动登录)。
 * 内置 CLI 尚未就绪(启动期二进制还在准备)不算失败、不进退避:就绪后启动流程会再读一次。
 */
function refreshClaudeCliLoginStatus(options?: { force?: boolean; configDir?: string }): Promise<ClaudeCliLoginStatus> {
  if (options?.configDir) return readProfileStatus(options.configDir, options.force);
  if (statusInflight) return statusInflight;
  if (!cliBinaryPath()) return Promise.resolve(statusFallback());
  if (
    options?.force !== true &&
    lastStatusFailureAt !== null &&
    Date.now() - lastStatusFailureAt < STATUS_FAILURE_BACKOFF_MS
  ) {
    return Promise.resolve(statusFallback());
  }
  const flight = (async () => {
    try {
      const status = await ports.readStatus({
        binary: cliBinaryPath()!,
        env: await cliEnv({ network: false }),
        timeoutMs: STATUS_TIMEOUT_MS,
      });
        if (!status) {
        lastStatusFailureAt = Date.now();
        log.warn('claude auth status returned an unexpected payload');
        return statusFallback();
      }
      lastStatusFailureAt = null;
      publishClaudeCliLoginStatus(status);
      return status;
    } catch (err) {
      lastStatusFailureAt = Date.now();
      log.warn('claude auth status failed', { error: err instanceof Error ? err.message : String(err) });
      return statusFallback();
    }
  })();
  statusInflight = flight;
  void flight.finally(() => {
    if (statusInflight === flight) statusInflight = null;
  });
  return flight;
}

/**
 * 缓存不超过 maxAgeMs 时直接返回,否则重读。登录态可能在 Cindy 之外变化(终端里
 * `claude auth logout`),会话启动这类要结论的调用方传较短的 maxAgeMs。
 *
 * staleWhileRevalidate:有缓存(哪怕过期)就立即返回它,过期时在后台重读;从未读到过
 * 时也不等待,按未登录返回。结果变化由 onClaudeCliLoginStatusChange 通知。用于列表类
 * 读取,不让与 Claude 订阅无关的操作等 CLI 进程。
 */
async function readClaudeCliLoginStatus(options?: {
  maxAgeMs?: number;
  staleWhileRevalidate?: boolean;
  configDir?: string;
}): Promise<ClaudeCliLoginStatus> {
  if (options?.configDir) return readProfileStatus(options.configDir);
  const cached = peekClaudeCliLoginStatus();
  if (cached && isClaudeCliLoginStatusFresh(options?.maxAgeMs ?? Number.POSITIVE_INFINITY)) return cached;
  if (options?.staleWhileRevalidate === true) {
    void refreshClaudeCliLoginStatus();
    return statusFallback();
  }
  return refreshClaudeCliLoginStatus();
}

// ── 套餐余量 ──────────────────────────────────────────────────────────────────

const PLAN_USAGE_TIMEOUT_MS = 20_000;
const PLAN_USAGE_REQUEST_ID = 'cindy-plan-usage';


/**
 * 读 Claude 订阅套餐余量:拉起内置 CLI 的 SDK 模式,发 `get_usage` 控制请求(CLI 的
 * /usage 同源,结构化返回),拿到响应即结束进程。请求由 CLI 用自己的登录发出,Cindy
 * 不接触凭证;不发用户消息,不产生模型调用。
 *
 * `get_usage` 是 CLI 标注为 Experimental 的控制请求,响应形状可能变化 —— 这里只取
 * `rate_limits` 原样交给调用方解析。CLI 明确声明当前账号没有套餐余量
 * (`rate_limits_available: false`)时返回 null;启动失败、超时、控制请求报错或响应缺
 * `rate_limits` 时抛错,由调用方退避。
 */
async function readClaudeCliPlanUsage(configDir?: string): Promise<ClaudeCliPlanUsage | null> {
  const binary = cliBinaryPath();
  if (!binary) throw new Error('claude cli unavailable');
  const env = await cliEnv({ network: true, configDir });
  // --setting-sources user:不读工作区的项目级设置(它们可改写上游 / 鉴权);
  // --strict-mcp-config:不拉起用户配置的 MCP server;--no-session-persistence:不落会话记录。
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'user',
  ];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let buffer = '';
    const finish = (err: Error | null, value?: ClaudeCliPlanUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(new Error('claude get_usage timed out')), PLAN_USAGE_TIMEOUT_MS);
    child.once('error', (err) => finish(err));
    child.once('close', (code) => finish(new Error(`claude cli exited before get_usage response (code ${code})`)));
    child.stdin?.on('error', () => {
      /* 进程提前退出时写 stdin 会 EPIPE,由 close 分支给结论。 */
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const outcome = parseClaudeCliPlanUsageLine(line);
        if (outcome) finish(outcome.error ? new Error(outcome.error) : null, outcome.usage);
      }
    });
    const write = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    write({ type: 'control_request', request_id: 'cindy-init', request: { subtype: 'initialize' } });
    write({
      type: 'control_request',
      request_id: PLAN_USAGE_REQUEST_ID,
      request: { subtype: 'get_usage', skip_behaviors: true },
    });
  });
}

/**
 * 解析 CLI stream-json 输出的一行。不是 `get_usage` 的 control_response 时返回 null
 * (继续读);是则返回结论:error 为控制请求失败,usage 为 null 表示账号没有套餐余量。
 */
function parseClaudeCliPlanUsageLine(
  line: string,
): { error?: string; usage: ClaudeCliPlanUsage | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as { type?: unknown; response?: unknown };
  if (message.type !== 'control_response' || !message.response || typeof message.response !== 'object') return null;
  const response = message.response as Record<string, unknown>;
  if (response.request_id !== PLAN_USAGE_REQUEST_ID) return null;
  if (response.subtype !== 'success') {
    return { error: `claude get_usage failed: ${optionalString(response.error) ?? 'unknown error'}`, usage: null };
  }
  const body = response.response && typeof response.response === 'object'
    ? (response.response as Record<string, unknown>)
    : {};
  // 只有 CLI 明确声明没有套餐余量才返回 null;缺 rate_limits 按形状变化报错,不当成「没有」。
  if (body.rate_limits_available === false) return { usage: null };
  if (!body.rate_limits || typeof body.rate_limits !== 'object') {
    return { error: 'claude get_usage response has no rate_limits', usage: null };
  }
  const subscriptionType = optionalString(body.subscription_type);
  return { usage: { rateLimits: body.rate_limits, ...(subscriptionType ? { subscriptionType } : {}) } };
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

let currentLogin: { key: string | undefined; abort: AbortController } | null = null;

/** 开始一次登录;同一时刻只保留一个,新登录会取消旧的。 */
function beginClaudeCliLogin(loginKey?: string): AbortSignal {
  cancelClaudeCliLogin();
  const abort = new AbortController();
  currentLogin = { key: loginKey, abort };
  return abort.signal;
}

/** 取消进行中的登录(传 loginKey 时只取消同一次)。 */
function cancelClaudeCliLogin(loginKey?: string): void {
  if (!currentLogin) return;
  if (loginKey && currentLogin.key !== loginKey) return;
  currentLogin.abort.abort();
  currentLogin = null;
}



/**
 * 已登录则直接返回;否则拉起 `claude auth login --claudeai`,由 CLI 打开浏览器并等待
 * 授权回调。CLI 退出后重读登录态作为结论。
 *
 * CLI 已用非订阅方式登录(API Key、中转 token 等)时直接返回 not_a_subscription,不替用户
 * 改 CLI 的登录:这类配置在 CLI 里优先于订阅登录,改了也用不上,还会影响终端里的 claude。
 */
async function runClaudeCliLogin(signal: AbortSignal, configDir?: string): Promise<ClaudeCliLoginResult> {
  const before = await refreshClaudeCliLoginStatus({ force: true, configDir });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (before.loggedIn) return { ok: true, status: before };
  if (before.notSubscription) return { ok: false, reason: 'not_a_subscription' };
  if (!cliBinaryPath()) return { ok: false, reason: 'local_unavailable' };
  try {
    const result = await runCli(['auth', 'login', '--claudeai'], {
      env: await cliEnv({ network: true, configDir }),
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal,
    });
    if (result.reason === 'cancelled') return { ok: false, reason: 'login_cancelled' };
    if (result.reason === 'timeout') return { ok: false, reason: 'timeout' };
    if (result.code !== 0) {
      log.warn('claude auth login exited with an error', { code: result.code });
    }
  } catch (err) {
    log.warn('claude auth login failed to start', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'local_unavailable' };
  }
  const after = await refreshClaudeCliLoginStatus({ force: true, configDir });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (after.loggedIn) return { ok: true, status: after };
  return { ok: false, reason: after.notSubscription ? 'not_a_subscription' : 'login_failed' };
}

/** @internal 单测用。 */
function resetClaudeNativeCliForTest(): void {
  resetClaudeCliLoginStatusForTest();
  statusInflight = null;
  lastStatusFailureAt = null;
  currentLogin = null;
  profileStatuses.clear();
}

return { claudeCliNetworkEnv, refreshClaudeCliLoginStatus, readClaudeCliLoginStatus, readClaudeCliPlanUsage, parseClaudeCliPlanUsageLine, beginClaudeCliLogin, cancelClaudeCliLogin, runClaudeCliLogin, resetClaudeNativeCliForTest };
}
