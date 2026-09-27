/**
 * claude-native-cli —— Claude 订阅的唯一接入面:Cindy 内置的官方 Claude Code CLI。
 *
 * Anthropic 只允许用户用自己的订阅登录**未修改的 Claude Code**;第三方应用不得提供
 * Claude.ai 登录,也不得收集、存储或中转订阅凭证(Claude Code 法律与合规文档)。所以:
 *
 *   - 登录 = 拉起内置 CLI 的 `claude auth login --claudeai`。浏览器授权与 token 交换
 *     全在 CLI 里完成,凭证落在 CLI 的默认凭证库(macOS 钥匙串 / ~/.claude),与终端里
 *     的 `claude` 共用同一份;
 *   - 登录态 = `claude auth status --json` 的结果。Cindy 从不读取凭证库本身;
 *   - 会话 = SDK 拉起同一个 CLI,由它自己读取、刷新凭证并直连 Anthropic
 *     (maker-core env-builder `nativeCliAuth`)。
 *
 * 「断开」只撤销 Cindy 的使用许可(nativeProviderAuthBinding),不登出 CLI。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { cleanProcessEnv } from '@cindy/maker-core';
import { hasProxyEnvConfig, parseOutboundProxyUrl } from '@cindy/anthropic-compat-proxy';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { createLogger } from '../logger.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
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
export async function claudeCliNetworkEnv(): Promise<Record<string, string>> {
  const fromEnv = hasProxyEnvConfig();
  let raw: string | null | undefined = null;
  try {
    raw = await resolveDesktopOutboundProxy(ANTHROPIC_API_ORIGIN);
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
    bridge = await ensureClaudeCliProxyBridge(resolveDesktopOutboundProxy);
  } catch {
    return {};
  }
  const noProxy: Record<string, string> = fromEnv ? {} : { NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY };
  return { HTTPS_PROXY: bridge, https_proxy: bridge, ...noProxy };
}

function cliBinaryPath(): string | null {
  return getReadyBinaryPath('claude-code') ?? null;
}

/**
 * 登录与登录态检查用 CLI 默认配置目录(dev 多实例也一样),凭证库因此与终端里的
 * `claude`、订阅会话共用同一份。process.env 的 CLAUDE_CONFIG_DIR 在 boot 期已被剥离。
 */
async function cliEnv(options: { network: boolean }): Promise<NodeJS.ProcessEnv> {
  return {
    ...cleanProcessEnv(),
    ...(options.network ? await claudeCliNetworkEnv() : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 解析 `claude auth status --json`;形状不符按未登录处理(不抛)。 */
export function parseClaudeCliLoginStatus(stdout: string): ClaudeCliLoginStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== 'boolean') return null;
  const authMethod = optionalString(record.authMethod);
  const apiProvider = optionalString(record.apiProvider);
  if (!record.loggedIn || authMethod === 'none') return { loggedIn: false };
  // 只认 Claude.ai 订阅账号的 OAuth 登录。CLI 对 Console 账号(`/login managed key`)也报
  // authMethod 'claude.ai',但会同时给出 apiKeySource;API Key / apiKeyHelper / 中转 token
  // (ANTHROPIC_AUTH_TOKEN 等)与 Bedrock / Vertex 等第三方云都不是「Claude 订阅」。
  const subscription =
    authMethod === 'claude.ai' &&
    optionalString(record.apiKeySource) === undefined &&
    (apiProvider === undefined || apiProvider === 'firstParty');
  if (!subscription) return { loggedIn: false, notSubscription: true };
  const subscriptionType = optionalString(record.subscriptionType);
  const email = optionalString(record.email);
  return {
    loggedIn: true,
    ...(authMethod ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(email ? { email } : {}),
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

// ── 登录态 ────────────────────────────────────────────────────────────────────

let statusInflight: Promise<ClaudeCliLoginStatus> | null = null;
let lastStatusFailureAt: number | null = null;

function statusFallback(): ClaudeCliLoginStatus {
  return peekClaudeCliLoginStatus() ?? { loggedIn: false };
}

/**
 * 读 CLI 登录态(`claude auth status --json`,约 0.1–0.3s)。同一时刻只跑一个;
 * 读失败(超时 / 输出异常 / 拉起失败)时保留上一次结果,从未读到过则视为未登录,
 * 并在 STATUS_FAILURE_BACKOFF_MS 内不再重试(force 除外,如用户主动登录)。
 * 内置 CLI 尚未就绪(启动期二进制还在准备)不算失败、不进退避:就绪后启动流程会再读一次。
 */
export function refreshClaudeCliLoginStatus(options?: { force?: boolean }): Promise<ClaudeCliLoginStatus> {
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
      const result = await runCli(['auth', 'status', '--json'], {
        env: await cliEnv({ network: false }),
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const status = parseClaudeCliLoginStatus(result.stdout);
      if (!status) {
        lastStatusFailureAt = Date.now();
        log.warn('claude auth status returned an unexpected payload', {
          code: result.code,
          reason: result.reason ?? null,
        });
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
export async function readClaudeCliLoginStatus(options?: {
  maxAgeMs?: number;
  staleWhileRevalidate?: boolean;
}): Promise<ClaudeCliLoginStatus> {
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

export interface ClaudeCliPlanUsage {
  /** `get_usage` 响应的 `rate_limits`(与 claude.ai /usage 同形,由 shared 解析器 fail-safe 解析)。 */
  rateLimits: unknown;
  subscriptionType?: string;
}

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
export async function readClaudeCliPlanUsage(): Promise<ClaudeCliPlanUsage | null> {
  const binary = cliBinaryPath();
  if (!binary) throw new Error('claude cli unavailable');
  const env = await cliEnv({ network: true });
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
export function parseClaudeCliPlanUsageLine(
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
export function beginClaudeCliLogin(loginKey?: string): AbortSignal {
  cancelClaudeCliLogin();
  const abort = new AbortController();
  currentLogin = { key: loginKey, abort };
  return abort.signal;
}

/** 取消进行中的登录(传 loginKey 时只取消同一次)。 */
export function cancelClaudeCliLogin(loginKey?: string): void {
  if (!currentLogin) return;
  if (loginKey && currentLogin.key !== loginKey) return;
  currentLogin.abort.abort();
  currentLogin = null;
}

export type ClaudeCliLoginResult =
  | { ok: true; status: ClaudeCliLoginStatus }
  | {
      ok: false;
      reason: 'login_cancelled' | 'timeout' | 'local_unavailable' | 'login_failed' | 'not_a_subscription';
    };

/**
 * 已登录则直接返回;否则拉起 `claude auth login --claudeai`,由 CLI 打开浏览器并等待
 * 授权回调。CLI 退出后重读登录态作为结论。
 *
 * CLI 已用非订阅方式登录(API Key、中转 token 等)时直接返回 not_a_subscription,不替用户
 * 改 CLI 的登录:这类配置在 CLI 里优先于订阅登录,改了也用不上,还会影响终端里的 claude。
 */
export async function runClaudeCliLogin(signal: AbortSignal): Promise<ClaudeCliLoginResult> {
  const before = await refreshClaudeCliLoginStatus({ force: true });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (before.loggedIn) return { ok: true, status: before };
  if (before.notSubscription) return { ok: false, reason: 'not_a_subscription' };
  if (!cliBinaryPath()) return { ok: false, reason: 'local_unavailable' };
  try {
    const result = await runCli(['auth', 'login', '--claudeai'], {
      env: await cliEnv({ network: true }),
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
  const after = await refreshClaudeCliLoginStatus({ force: true });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (after.loggedIn) return { ok: true, status: after };
  return { ok: false, reason: after.notSubscription ? 'not_a_subscription' : 'login_failed' };
}

/** @internal 单测用。 */
export function resetClaudeNativeCliForTest(): void {
  resetClaudeCliLoginStatusForTest();
  statusInflight = null;
  lastStatusFailureAt = null;
  currentLogin = null;
}
