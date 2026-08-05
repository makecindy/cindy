/**
 * provider-diagnostics —— 供应商「测试连接」探测（设置页 / 自定义供应商表单消费）。
 *
 * 设计要点：
 *   - **探测与真实会话同路由口径**：saved 模式从 active-catalog 取该供应商的 RoutingDescriptor
 *     （upstream / headerOverride）+ safeStorage 里的 per-runtime API key，与 provider-route.ts
 *     的 `api-key-header` 分支构造相同的 header 组合（cc 同时覆盖 x-api-key + authorization，
 *     codex 只覆盖 authorization）——测通了 = 真实请求也走得通，比裸 HEAD 探测可信。
 *   - **adhoc 模式**支持表单未保存值直接测（baseUrl / modelId / key 内存透传，不落任何盘）。
 *   - 最小探测请求：cc wire = `POST /v1/messages`（max_tokens=1）；codex wire = `POST /responses`
 *     （max_output_tokens=16, stream=false）。10s 超时。
 *   - 结果判定走 shared/providerErrors 的结构化分类器（与 Phase 2 会话内上游错误同一套口径）。
 *   - fetch 可注入（单测不联网）；key 读取器可注入（不直接 import safeStorage，模式同
 *     provider-route.setCustomProviderKeyReader，host 在 register 时接通）。
 */

import {
  appendProviderRequestPath,
  isAgentSelectableModel,
  isLoopbackProviderUrl,
  type AgentKind,
  type ProviderWireProtocol,
} from '@cindy/model-providers';

import {
  classifyProviderError,
  type ProviderErrorClassification,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';
import { getActiveCatalog } from './active-catalog.js';
import { outboundFetch } from './outbound-fetch.js';

/** 探测请求超时。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** 一次探测的完整参数（adhoc 直填；saved 由 resolve 得到）。 */
export interface ProviderProbeSpec {
  agent: AgentKind;
  baseUrl: string;
  modelId: string;
  /** 表单态鉴权方式；main IPC 用它强制 none 只访问 loopback。 */
  authMethod?: 'apiKey' | 'oauth' | 'none';
  /** 缺省按 agent 保持历史行为。 */
  wireProtocol?: ProviderWireProtocol;
  /** 非标准推理端点的精确相对路径。 */
  requestPath?: string;
  /** 用户 API key；缺省 = 不注入鉴权头（端点可能靠自定义 headers 鉴权）。 */
  apiKey?: string | null;
  /** 附加请求头（自定义供应商的 headers 配置）。 */
  headers?: Record<string, string>;
}

/** 测试入参：已保存供应商（key 从 safeStorage 读）或表单态 adhoc。 */
export type ProviderTestInput =
  | { kind: 'saved'; providerId: string; agent: AgentKind }
  | { kind: 'adhoc'; spec: ProviderProbeSpec };

/** 结构化测试结果（查询型返回：renderer 需要 code 渲染分类文案，不走 throwIpcError）。 */
export interface ProviderTestResult {
  ok: boolean;
  /** 失败分类码（ok=true 时缺省）。 */
  code?: ProviderErrorCode;
  /** HTTP 状态码（网络层失败时缺省）。 */
  status?: number;
  latencyMs: number;
  /** 上游原始信息摘要（详情展开用，UI 主文案走 i18n）。 */
  detail?: string;
}

// ── key 读取注入（同 provider-route 模式，避免纯逻辑单测触电 safeStorage）─────────
type KeyReader = (providerId: string, agent: AgentKind) => string | null;
let keyReader: KeyReader = () => null;

/** host 启动期接通真实 safeStorage 读取（`provider_key_<id>_<agent>`）。 */
export function setDiagnosticsKeyReader(reader: KeyReader): void {
  keyReader = reader;
}

function withoutCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'x-api-key';
    }),
  );
}

/** 构造探测请求（纯函数，单测直断言）。header 组合与 provider-route 的 api-key-header 分支对齐。 */
export function buildProbeRequest(spec: ProviderProbeSpec): { url: string; init: RequestInit } {
  const mustStripCredentialHeaders =
    !!spec.apiKey || spec.authMethod === 'none' || spec.authMethod === 'oauth';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(mustStripCredentialHeaders
      ? withoutCredentialHeaders(spec.headers)
      : (spec.headers ?? {})),
  };
  if (spec.agent === 'claude-code') {
    // Anthropic Messages wire。anthropic-version 为兼容端点普遍要求的必带头。
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    if (spec.apiKey) {
      headers['x-api-key'] = spec.apiKey;
      headers['authorization'] = `Bearer ${spec.apiKey}`;
    }
    return {
      url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? '/v1/messages'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: spec.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
    };
  }
  // codex：原生 Responses 或 Cindy 将承载的 Chat Completions 上游。
  if (spec.apiKey) headers['authorization'] = `Bearer ${spec.apiKey}`;
  if (spec.wireProtocol === 'openai-chat') {
    // 「测试连接」= 验证 endpoint + key + Chat 协议 + 流式可达,**不强制 tool_choice**:
    // 部分供应商的思考模型(如 DeepSeek deepseek-v4-pro)明确拒绝强制工具调用
    // (“Thinking mode does not support this tool_choice”),会把可达的端点误报成失败。
    // 工具调用能力交给真实会话验证(Codex 用 tool_choice:'auto',不强制)。
    return {
      url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? '/chat/completions'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: spec.modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
    };
  }
  return {
    url: appendProviderRequestPath(spec.baseUrl, spec.requestPath ?? '/responses'),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: spec.modelId,
        input: 'ping',
        max_output_tokens: 16,
        stream: false,
        store: false,
      }),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the first non-empty SSE data frame so 200-streamed provider errors do not pass the probe. */
async function readFirstSsePayload(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf('\n', start)) >= 0) {
        const line = buffer.slice(start, newline).replace(/\r$/, '');
        start = newline + 1;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) return payload;
      }
      if (start > 0) buffer = buffer.slice(start);
      if (buffer.length > MAX_ERROR_BODY_BYTES) return null;
      if (done) {
        buffer += decoder.decode();
        const line = buffer.replace(/\r$/, '');
        if (!line.startsWith('data:')) return null;
        return line.slice(5).trim() || null;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* no-op */
    }
  }
}

function classifyStreamedError(error: Record<string, unknown>): ProviderErrorClassification {
  const bodyText = JSON.stringify(error).slice(0, MAX_ERROR_BODY_BYTES);
  const explicitStatus = typeof error.status === 'number' ? error.status
    : typeof error.status_code === 'number' ? error.status_code
      : typeof error.code === 'number' ? error.code
        : undefined;
  const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
  const inferredStatus = explicitStatus ?? (type.includes('server') || type.includes('overload') ? 503 : 400);
  return classifyProviderError({ status: inferredStatus, bodyText });
}

/** 从 Error（fetch 抛出）提取网络层错误码。 */
function networkErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    return err.name || 'UNKNOWN_NETWORK_ERROR';
  }
  return 'UNKNOWN_NETWORK_ERROR';
}

/** 跑一次探测请求并分类结果。fetch 可注入（单测）。 */
export async function runProviderProbe(
  spec: ProviderProbeSpec,
  // 默认吃系统代理:探测必须与真实会话同口径,否则代理用户会被误判成「连不通」。
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderTestResult> {
  if (spec.authMethod === 'none' && !isLoopbackProviderUrl(spec.baseUrl)) {
    throw new TypeError('no-auth provider probes require a loopback URL');
  }
  const { url, init } = buildProbeRequest(spec);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
    return { ok: false, code: cls.code, latencyMs: Date.now() - start, detail: cls.detail };
  }
  const latencyMs = Date.now() - start;
  if (res.ok) {
    // openai-chat 探测发的是 `stream: true`,真实 Chat 桥现在会拒绝非 SSE 的 2xx 响应
    // (返回 200 application/json 的伪流式端点)。探测必须同口径校验 content-type,否则
    // 这类端点会「测试连接」通过、首个真实 Codex 会话却被桥拒 —— 结论自相矛盾。
    if (spec.wireProtocol === 'openai-chat') {
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        try {
          await res.body?.cancel();
        } catch {
          /* no-op */
        }
        return {
          ok: false,
          code: 'WIRE_INCOMPATIBLE',
          status: res.status,
          latencyMs,
          detail: `expected text/event-stream, got ${contentType || 'no content-type'}`,
        };
      }
      const firstPayload = await readFirstSsePayload(res);
      if (!firstPayload) {
        return {
          ok: false,
          code: 'WIRE_INCOMPATIBLE',
          status: res.status,
          latencyMs,
          detail: 'stream ended before the first SSE data frame',
        };
      }
      if (firstPayload !== '[DONE]') {
        try {
          const event: unknown = JSON.parse(firstPayload);
          if (isPlainObject(event) && isPlainObject(event.error)) {
            const cls = classifyStreamedError(event.error);
            return { ok: false, code: cls.code, status: res.status, latencyMs, detail: cls.detail };
          }
        } catch {
          return {
            ok: false,
            code: 'WIRE_INCOMPATIBLE',
            status: res.status,
            latencyMs,
            detail: 'first SSE data frame is not valid JSON',
          };
        }
      }
      return { ok: true, latencyMs };
    }
    // Non-streaming probes do not need the response body; cancel it to release the connection.
    try {
      await res.body?.cancel();
    } catch {
      /* no-op */
    }
    return { ok: true, latencyMs };
  }
  let bodyText = '';
  try {
    bodyText = (await res.text()).slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    /* 读体失败按空体分类 */
  }
  const cls = classifyProviderError({ status: res.status, bodyText });
  return { ok: false, code: cls.code, status: res.status, latencyMs, detail: cls.detail };
}

/**
 * 解析 saved 入参 → 探测 spec。仅支持自定义(user)供应商 —— 内置 OAuth / 网关来源的连接态
 * 由各自鉴权通道保证，不在此探测。解析失败抛 Error（handler 映射 INVALID_PARAMS）。
 */
export function resolveSavedProbeSpec(providerId: string, agent: AgentKind): ProviderProbeSpec {
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider '${providerId}' not found`);
  if (provider.source !== 'user') throw new Error(`provider '${providerId}' is not a custom provider`);
  const routing = provider.routing[agent];
  if (!routing) throw new Error(`provider '${providerId}' has no runtime for '${agent}'`);
  if (routing.disabled) throw new Error(`provider '${providerId}' runtime '${agent}' is disabled`);
  // 探测发的是聊天形状的最小请求(见下方 requestPath/body 组装);挑第一个非聊天模型
  // (image/embedding/...)会把探测发给一个本来就不接受聊天请求的端点,得到的失败结论
  // 和"这个供应商配置是坏的"完全无关(2026-07 review,与 issue #882 第 3 点同一类问题)。
  const model = (provider.models[agent] ?? []).find((m) =>
    isAgentSelectableModel(m, { userProvider: provider.source === 'user' }),
  );
  if (!model) throw new Error(`provider '${providerId}' has no chat models for '${agent}'`);
  // OAuth 形态：探测凭证用 Runner 持有的 access_token（与 oauth-token 路由同源），未登录时
  // 无 token → 探测会得到 AUTH_INVALID，这本身就是「先去登录」的正确结论。
  // token 走 authorization 头而**不走 apiKey 字段**——apiKey 会让 cc 探测同时发
  // `x-api-key: <token>`,而真实 oauth-token 路由明确删除 x-api-key;优先按 x-api-key
  // 鉴权的端点会把 access_token 当 API key 校验得到 401,探测结论就与真实会话相反了。
  if (routing.authStrategy === 'oauth-token') {
    const oauthToken = oauthProbeTokenReader(providerId);
    return {
      agent,
      baseUrl: routing.upstream,
      modelId: model.id,
      wireProtocol: routing.wireProtocol,
      requestPath: routing.requestPath,
      apiKey: null,
      headers: {
        ...withoutCredentialHeaders(routing.headerOverride),
        ...(oauthToken ? { authorization: `Bearer ${oauthToken}` } : {}),
      },
    };
  }
  if (routing.authStrategy === 'none') {
    return {
      agent,
      baseUrl: routing.upstream,
      modelId: model.id,
      wireProtocol: routing.wireProtocol,
      requestPath: routing.requestPath,
      apiKey: null,
      headers: withoutCredentialHeaders(routing.headerOverride),
    };
  }
  const apiKey = keyReader(providerId, agent);
  return {
    agent,
    baseUrl: routing.upstream,
    modelId: model.id,
    // 与 oauth-token 分支对齐：Chat 桥接供应商（api-key-header + openai-chat）的 saved 探测
    // 必须带上 wireProtocol，否则 buildProbeRequest 回落到原生 /responses，对 Chat-only 上游
    // 误报连接失败（真实会话走 resolveSessionRoute 不受影响，探测结论会与真实会话相反）。
    wireProtocol: routing.wireProtocol,
    requestPath: routing.requestPath,
    apiKey,
    // 与真实会话路由保持 legacy 兼容：safeStorage 已有 key 时清掉旧凭证头，由 apiKey
    // 重新注入；尚未迁移的 header-only 配置则原样保留，否则“测试连接”会无凭证误报失败。
    headers: apiKey
      ? withoutCredentialHeaders(routing.headerOverride)
      : { ...(routing.headerOverride ?? {}) },
  };
}

// OAuth 探测 token 读取器（注入，同 keyReader 模式；生产 = readCachedGenericOAuthAccessToken）。
type OAuthProbeTokenReader = (providerId: string) => string | null;
let oauthProbeTokenReader: OAuthProbeTokenReader = () => null;

/** host 启动期接通 generic-oauth 的同步 token 缓存读取（探测用）。 */
export function setDiagnosticsOAuthTokenReader(reader: OAuthProbeTokenReader): void {
  oauthProbeTokenReader = reader;
}

/** 测试入口（IPC handler 消费）。 */
export async function testProviderConnection(
  input: ProviderTestInput,
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderTestResult> {
  const spec = input.kind === 'saved' ? resolveSavedProbeSpec(input.providerId, input.agent) : input.spec;
  return runProviderProbe(spec, fetchImpl);
}
