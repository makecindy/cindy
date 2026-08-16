/**
 * provider-upstream-error-observer —— 自定义供应商上游错误的只读观察 + 结构化广播。
 *
 * 挂在两个 loopback proxy 的 `composeResponseObservers` 组合里（cc / codex 各一实例）：
 * status ≥ 400 时 tee 错误体（≤16KB，按 content-encoding 解压）→ shared/providerErrors
 * 分类 → 经注入的 broadcaster 推 `PROVIDER_UPSTREAM_ERROR` 给 renderer（toast 人话提示）。
 *
 * 规则 10 红线（proxy 热路径）：
 *   - 成功响应（status < 400）直接返回 null sink —— 零 tee、零累积、零开销；
 *   - 只读观察，绝不改写响应 / 阻塞 pipe（包契约）；
 *   - 只对「会话显式路由到自定义(user)供应商」的请求广播 —— 内置来源（订阅 / 网关）已有
 *     各自的失效广播与 rate-limit 观察，重复报会刷屏；providerId 反解不到就静默跳过。
 *   - 同 (providerId, code) 30s 节流：流式会话中同一坏配置会连环 400，不能每个都弹。
 *   - count_tokens 的 404 不广播：不少 Anthropic 兼容上游（如 Moonshot /anthropic）没实现
 *     这个辅助计量端点，CLI 自带本地估算兜底、主链路 /v1/messages 不受影响，弹
 *     「端点不存在，请检查基础 URL」纯属误导（2026-07-21 kimi-moonshot 实测误报）。
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import type { ResponseObserver, ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';
import type { AgentKind } from '@cindy/model-providers';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

import {
  classifyProviderError,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';

/** 广播给 renderer 的结构化上游错误事件（payload 走 MAKER_PUSH.PROVIDER_UPSTREAM_ERROR）。 */
export interface ProviderUpstreamErrorEvent {
  agent: AgentKind;
  providerId: string;
  providerName: string;
  code: ProviderErrorCode;
  retryable: boolean;
  status: number;
  /** 上游原始信息摘要（renderer 详情展开用；主文案走 providerError.* i18n）。 */
  detail?: string;
  /**
   * 上游 JSON 错误体中的 `error.type`（低风险字段，不含 message —— message 可能
   * 回显请求字段 / prompt 片段）。用于区分「中转层自身路由拒绝」与官方 400（#2333）。
   */
  errorType?: string;
  /**
   * 本地代理层请求序号（见 anthropic-compat-proxy ResponseObserverCtx.reqId）。
   * 供用户对照 `cc-proxy.log` / `agent-*.ndjson` 拉出完整往返；与上游 request ID 无关。
   * 仅 observer 路径（请求经 compat-proxy 转发）有；localHandler 桥接路径无此值。
   */
  reqId?: number;
}

/** 错误体累积上限（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
/** 同 (providerId, code) 的广播节流窗口。 */
const THROTTLE_MS = 30_000;

// broadcaster 由 host（register.ts）注入 —— 本模块不 import Electron，可脱 Electron 单测。
type Broadcaster = (event: ProviderUpstreamErrorEvent) => void;
let _broadcast: Broadcaster = () => {};
export function setProviderUpstreamErrorBroadcaster(fn: Broadcaster): void {
  _broadcast = fn;
}

/** 请求路径（去 query）是否为 count_tokens 辅助计量端点。 */
function isCountTokensUrl(url: string): boolean {
  return url.split('?', 1)[0].endsWith('/count_tokens');
}

// 桥接 localHandler 路径的节流表：Responses→Chat bridge 不经 proxy responseObserver,
// 需要一条独立入口把上游错误分类后广播给 renderer(与 observer 同一 broadcaster、同一节流窗口)。
const bridgeLastEmit = new Map<string, number>();

/**
 * 直接上报一次自定义供应商上游错误（供 localHandler 桥接路径调用；observer 走
 * createProviderUpstreamErrorObserver）。分类 + 同 (providerId, code) 30s 节流后广播。
 * 只应对「会话路由到自定义(user)供应商」的失败调用——与 observer 的 user-only 语义一致。
 */
export function reportProviderUpstreamError(params: {
  agent: AgentKind;
  providerId: string;
  providerName?: string;
  status: number;
  bodyText: string;
  now?: () => number;
}): void {
  const now = params.now ?? Date.now;
  const cls = classifyProviderError({ status: params.status, bodyText: params.bodyText });
  const key = `${params.agent}:${params.providerId}:${cls.code}`;
  const t = now();
  const prev = bridgeLastEmit.get(key);
  if (prev !== undefined && t - prev < THROTTLE_MS) return;
  bridgeLastEmit.set(key, t);
  _broadcast({
    agent: params.agent,
    providerId: params.providerId,
    providerName: params.providerName ?? params.providerId,
    code: cls.code,
    retryable: cls.retryable,
    status: params.status,
    detail: cls.detail,
    // localHandler 桥接路径绕开 compat-proxy 转发层，无本地 reqId（与 observer 一致）。
    errorType: extractErrorTypeFromBody(params.bodyText),
  });
}

/**
 * 按 content-encoding 解压错误体（与 proxy 包 debug dump 的解压语义一致；失败回退原文）。
 * 导出供其它 responseObserver 复用（如 xai 凭证收口），解压语义单点维护。
 */
export function decodeUpstreamErrorBody(buf: Buffer, encoding: string | undefined): string {
  try {
    if (encoding === 'gzip') return gunzipSync(buf).toString('utf-8');
    if (encoding === 'br') return brotliDecompressSync(buf).toString('utf-8');
    if (encoding === 'deflate') return inflateSync(buf).toString('utf-8');
  } catch {
    /* 解压失败回退原文（截断文本对 pattern 匹配仍可能有效） */
  }
  return buf.toString('utf-8');
}

/**
 * 从上游错误体提取低风险 `error.type`。支持两种形态：
 *  1. Anthropic / OpenAI / litellm 标准：`{ "error": { "type": "...", ... } }`
 *  2. responses-chat bridge 解包后的 streamed error：`{ "type": "...", ... }`
 *     （bridge 在 SSE 200 流内的错误帧里把 event.error 解包后 `JSON.stringify`
 *     传给回调，见 responses-chat-bridge handler.ts）
 * 只取 type 字符串，不取 message —— message 常回显请求字段值，会泄漏 prompt
 * 片段（与 proxy 包 extractErrorType 同口径）。
 * 非 JSON / 字段缺失 / 类型不符一律 undefined，调用方直接省略该字段。
 *
 * errorType 是上游（不可信输入）直接进 renderer 的诊断字段，采用 **fail-closed
 * 白名单**（chatgpt-codex-connector P1）：只接受已知的服务端错误分类枚举值，未知 /
 * 可疑值一律省略。枚举覆盖 Anthropic / OpenAI / litellm 与常见兼容网关的标准
 * `error.type`，以及 #2333 的核心诊断信号 `agent_router_api_error`（中转层自身
 * 路由拒绝，非官方 API 错误）。
 *
 * 选白名单而非黑名单 / 启发式的原因：凭证形态无法用前缀或熵穷尽——`ghp_...`、
 * `sk_ant_...`、任意纯字母不透明 token 都能伪装成「小写 snake_case」。而 errorType
 * 是增强诊断字段，对未知值保守省略只少一个展示细节，不损失主流程；这正是
 * `credentials-and-local-storage.md`「日志 / 错误不得包含凭证明文」硬约束要求的。
 */
const KNOWN_ERROR_TYPES = new Set([
  // Anthropic / OpenAI / litellm 标准错误类型
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
  'timeout_error',
  'invalid_argument',
  'content_policy_violation',
  'context_length_exceeded',
  'insufficient_quota',
  'model_not_found',
  'server_error',
  'connection_error',
  'bad_gateway',
  'service_unavailable',
  'unsupported_feature',
  // 中转层自身路由拒绝（#2333 核心诊断信号，非官方 API 错误）
  'agent_router_api_error',
  'upstream_error',
]);

function extractErrorTypeFromBody(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    // 标准包裹形态 { error: { type } }，其次 bridge 解包形态 { type }。
    const err = root.error ?? root;
    if (typeof err !== 'object' || err === null || Array.isArray(err)) return undefined;
    const t = (err as Record<string, unknown>).type;
    if (typeof t === 'string' && KNOWN_ERROR_TYPES.has(t)) return t;
  } catch {
    /* 截断 / 非 JSON：忽略 */
  }
  return undefined;
}

export interface ProviderUpstreamErrorObserverOptions {
  agent: AgentKind;
  /**
   * 从请求 headers 反解「该请求归属的自定义(user)供应商 id」。
   * 返回 null = 非自定义供应商流量（内置来源 / 反解不到），观察器直接跳过。
   * cc: x-claude-code-session-id → sdkSessionId resolver → session → provider；
   * codex: thread-id → threadToSession → session → provider。由各 proxy host 闭包提供。
   */
  resolveUserProviderId: (requestHeaders: Readonly<Record<string, string>>) => string | null;
  /** Resolve the non-secret display name for the user provider. */
  resolveUserProviderName?: (providerId: string) => string | null;
  /** 节流时钟（单测注入）。 */
  now?: () => number;
}

/**
 * 创建观察器实例。每个 proxy host 各建一个（cc / codex 的 header 反解方式不同）。
 * 节流表挂在实例上 —— 两个 proxy 各自独立，不跨 agent 串扰。
 */
export function createProviderUpstreamErrorObserver(
  opts: ProviderUpstreamErrorObserverOptions,
): ResponseObserver {
  const now = opts.now ?? Date.now;
  const lastEmit = new Map<string, number>();

  return (ctx: ResponseObserverCtx) => {
    if (ctx.status < 400) return null; // 成功路径零开销（规则 10）
    // count_tokens 404 = 上游没实现该辅助端点（良性缺失），不是配置错——见文件头注释。
    // 其余 status（401/429 等）照常广播：它们与主链路同因，是真信号。
    if (ctx.status === 404 && isCountTokensUrl(ctx.url)) return null;
    const providerId = opts.resolveUserProviderId(ctx.requestHeaders);
    if (!providerId) return null;

    const chunks: Buffer[] = [];
    let size = 0;
    return {
      onData: (chunk: Buffer) => {
        if (size >= MAX_ERROR_BODY_BYTES) return;
        chunks.push(chunk);
        size += chunk.length;
      },
      onEnd: () => {
        const encoding = ctx.responseHeaders['content-encoding'];
        const bodyText = decodeUpstreamErrorBody(
          Buffer.concat(chunks, Math.min(size, MAX_ERROR_BODY_BYTES)),
          typeof encoding === 'string' ? encoding : undefined,
        );
        const cls = classifyProviderError({ status: ctx.status, bodyText });
        const key = `${providerId}:${cls.code}`;
        const t = now();
        const prev = lastEmit.get(key);
        if (prev !== undefined && t - prev < THROTTLE_MS) return;
        lastEmit.set(key, t);
        _broadcast({
          agent: opts.agent,
          providerId,
          providerName: opts.resolveUserProviderName?.(providerId) ?? providerId,
          code: cls.code,
          retryable: cls.retryable,
          status: ctx.status,
          detail: cls.detail ? redactSensitiveText(cls.detail) : undefined,
          errorType: extractErrorTypeFromBody(bodyText),
          reqId: ctx.reqId,
        });
      },
      // 上游流错误：本次观察放弃即可（连接层问题由 proxy 主路径处理与记日志）。
      onError: () => {},
    };
  };
}
