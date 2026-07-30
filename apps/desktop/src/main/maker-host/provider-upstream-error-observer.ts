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
        });
      },
      // 上游流错误：本次观察放弃即可（连接层问题由 proxy 主路径处理与记日志）。
      onError: () => {},
    };
  };
}
