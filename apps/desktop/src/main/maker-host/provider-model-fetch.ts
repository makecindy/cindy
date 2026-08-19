/**
 * provider-model-fetch —— 供应商「获取模型列表」（自定义供应商表单消费）。
 *
 * 设计要点：
 *   - 与 OAuth 自动发现（generic-oauth.discoverGenericOAuthModels）同一套端点推导
 *     （`deriveModelsDiscoveryUrl`）与响应解析（`parseModelsListResponse`），差异只在
 *     鉴权：本模块吃表单透传的 API key（不落盘），头组合对齐 provider-diagnostics
 *     的 `buildProbeRequest`（cc 同时带 x-api-key + Bearer + anthropic-version，codex 只带 Bearer）。
 *   - 查询型结构化返回（规则 13 例外条款，同 test-connection）：renderer 需要 code
 *     渲染 providerError.* 分类文案。
 *   - fetch 可注入（单测不联网）。
 */

import {
  isLoopbackProviderUrl,
  type AgentKind,
  type DshReasoningEffort,
  type DshThinkingPolicy,
  type ProviderWireProtocol,
} from '@cindy/model-providers';

import {
  classifyProviderError,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';
import { deriveModelsDiscoveryUrl, parseModelsListResponse } from './generic-oauth.js';
import { DSH_PROVIDER_USER_AGENT } from './dsh-attribution.js';
import { normalizeDshProviderBaseUrl } from './dsh-provider-url.js';
import { outboundFetch } from './outbound-fetch.js';

/** 拉取超时（与 test-connection 探测同量级）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** 一次「获取模型列表」的完整参数（表单值内存透传，不落盘）。 */
export interface ProviderModelsFetchSpec {
  agent: AgentKind;
  /** 上游 wire protocol；用于区分 Codex 原生 OpenAI 与 Anthropic Messages 桥。 */
  wireProtocol?: ProviderWireProtocol;
  baseUrl: string;
  /** 表单态鉴权方式；main IPC 用它强制 none 只访问 loopback。 */
  authMethod?: 'apiKey' | 'oauth' | 'none';
  /** 显式列模型端点（预设 / 配置的 modelsUrl）；缺省由 baseUrl 推导 `…/v1/models`。 */
  modelsUrl?: string | null;
  /** 用户 API key；缺省 = 不注入鉴权头（端点可能靠自定义 headers 鉴权）。 */
  apiKey?: string | null;
  /** 附加请求头（自定义供应商的 headers 配置）。 */
  headers?: Record<string, string>;
  /**
   * 已保存自定义供应商 id：给出时 main 侧按 (id, agent) 读取已存的 main-only 鉴权请求头
   * 并并入 `headers`，无需 renderer 回读明文头（headers 是 main-only 密文，见
   * isRendererAccessibleSafeStorageKey）。仅用于“刷新模型”复用已存请求头鉴权的端点。
   */
  savedProviderId?: string;
}

/** 结构化结果（查询型返回：renderer 需要 code 渲染分类文案，不走 throwIpcError）。 */
export interface ProviderModelsFetchResult {
  ok: boolean;
  /** 拉到的模型清单（ok=true 时给出；已按 id 去重;contextWindow 为端点声明的上下文长度,尽力提取）。 */
  models?: {
    id: string;
    name: string;
    contextWindow?: number;
    dshReasoningEffort?: DshReasoningEffort;
    dshReasoningEfforts?: DshReasoningEffort[];
    dshThinkingPolicy?: DshThinkingPolicy;
  }[];
  /** 失败分类码（ok=false 时给出）。 */
  code?: ProviderErrorCode;
  /** HTTP 状态码（网络层失败时缺省）。 */
  status?: number;
  /** 上游原始信息摘要（详情展开用，UI 主文案走 i18n）。 */
  detail?: string;
}

/** 两个 URL 是否同源（scheme + host + 端口）。任一解析失败视为不同源（fail-closed）。 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function withoutCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== 'authorization' && lower !== 'x-api-key') normalized[lower] = value;
  }
  return normalized;
}

function normalizedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

/** 构造列模型请求（纯函数，单测直断言）。鉴权头组合与 buildProbeRequest 同口径。 */
export function buildModelsFetchRequest(spec: ProviderModelsFetchSpec): { url: string; init: RequestInit } {
  const mustStripCredentialHeaders =
    !!spec.apiKey || spec.authMethod === 'none' || spec.authMethod === 'oauth';
  const headers: Record<string, string> = mustStripCredentialHeaders
    ? withoutCredentialHeaders(spec.headers)
    : normalizedHeaders(spec.headers);
  if (spec.agent === 'dsh') headers['user-agent'] = DSH_PROVIDER_USER_AGENT;
  const anthropicMessages =
    spec.wireProtocol === 'anthropic-messages'
    || (spec.wireProtocol === undefined && spec.agent === 'claude-code');
  if (anthropicMessages) {
    // Anthropic wire 的所有端点（含 GET /v1/models）都要求 anthropic-version，缺失直接 400。
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    if (spec.apiKey) {
      headers['x-api-key'] = spec.apiKey;
      // `buildLocalHandlerHeaders` 已把 agent 自带凭证替换为 Provider-owned key。
      // 同时发送标准 Anthropic x-api-key 与兼容网关常用的 Bearer，和真实会话保持一致。
      headers['authorization'] = `Bearer ${spec.apiKey}`;
    }
  } else if (spec.apiKey) {
    headers['authorization'] = `Bearer ${spec.apiKey}`;
  }
  // modelsUrl 是用户不可见的隐藏字段（预设/配置快照）。只有与 baseUrl 同源才采用——
  // 防止用户改了 baseUrl 后，key 仍被发往快照里的旧主机 / 被降级成明文（现有预设全部同源）。
  const baseUrl = spec.agent === 'dsh'
    ? normalizeDshProviderBaseUrl(spec.baseUrl)
    : spec.baseUrl;
  if (!baseUrl) throw new TypeError('invalid DSH provider Base URL');
  const explicit = spec.modelsUrl?.trim();
  return {
    // The DSH adapter treats its configured endpoint as an exact OpenAI-compatible Base URL and
    // string-appends `/chat/completions`; model discovery must use the matching exact `/models`
    // sibling instead of the generic helper, which may insert an extra `/v1` segment.
    url: spec.agent === 'dsh'
      ? `${baseUrl}/models`
      : explicit && sameOrigin(explicit, baseUrl) ? explicit : deriveModelsDiscoveryUrl(baseUrl),
    init: { method: 'GET', headers },
  };
}

/** 从 Error（fetch 抛出）提取网络层错误码（同 provider-diagnostics）。 */
function networkErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    return err.name || 'UNKNOWN_NETWORK_ERROR';
  }
  return 'UNKNOWN_NETWORK_ERROR';
}

/** 拉一次模型列表并分类结果。fetch 可注入（单测）。 */
export async function fetchProviderModels(
  spec: ProviderModelsFetchSpec,
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderModelsFetchResult> {
  if (
    spec.authMethod === 'none'
    && (
      !isLoopbackProviderUrl(spec.baseUrl)
      || (!!spec.modelsUrl?.trim() && !isLoopbackProviderUrl(spec.modelsUrl.trim()))
    )
  ) {
    return {
      ok: false,
      code: 'UNKNOWN',
      detail: 'no-auth provider model discovery requires loopback URLs',
    };
  }
  const { url, init } = buildModelsFetchRequest(spec);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
    return { ok: false, code: cls.code, detail: cls.detail };
  }
  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = (await res.text()).slice(0, MAX_ERROR_BODY_BYTES);
    } catch {
      /* 读体失败按空体分类 */
    }
    const cls = classifyProviderError({ status: res.status, bodyText });
    return { ok: false, code: cls.code, status: res.status, detail: cls.detail };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: 'UNKNOWN', status: res.status, detail: 'models response is not JSON' };
  }
  const models = parseModelsListResponse(json);
  if (!models || models.length === 0) {
    // 端点 200 但响应不是可识别的模型列表（或为空）——按「模型不存在」类引导用户手填。
    return { ok: false, code: 'UNKNOWN', status: res.status, detail: 'no models found in response' };
  }
  if (spec.agent !== 'dsh') return { ok: true, models };
  const rawItems = json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)
    ? (json as { data: unknown[] }).data
    : [];
  const dshMetadata = new Map<string, {
    dshReasoningEffort?: DshReasoningEffort;
    dshReasoningEfforts?: DshReasoningEffort[];
    dshThinkingPolicy?: DshThinkingPolicy;
  }>();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string') continue;
    const thinkEfforts = record.think_efforts;
    let efforts: DshReasoningEffort[] | undefined;
    let defaultEffort: DshReasoningEffort | undefined;
    let thinkingPolicy: DshThinkingPolicy | undefined;
    if (thinkEfforts && typeof thinkEfforts === 'object' && !Array.isArray(thinkEfforts)) {
      const effortRecord = thinkEfforts as Record<string, unknown>;
      if (effortRecord.support === true && Array.isArray(effortRecord.valid_efforts)) {
        const allowed = new Set<DshReasoningEffort>(['off', 'low', 'high', 'max']);
        const parsed = effortRecord.valid_efforts.filter(
          (value): value is DshReasoningEffort => typeof value === 'string' && allowed.has(value as DshReasoningEffort),
        );
        if (parsed.length > 0 && new Set(parsed).size === parsed.length) efforts = parsed;
        if (
          typeof effortRecord.default_effort === 'string'
          && allowed.has(effortRecord.default_effort as DshReasoningEffort)
        ) {
          defaultEffort = effortRecord.default_effort as DshReasoningEffort;
        }
      }
    }
    if (!efforts && record.supports_thinking_type === 'only') {
      thinkingPolicy = 'always-on';
      defaultEffort = 'high';
    } else if (record.supports_thinking_type === 'no') {
      thinkingPolicy = 'always-off';
      defaultEffort = 'off';
      efforts = undefined;
    }
    if (efforts?.length) {
      const selected = defaultEffort && efforts.includes(defaultEffort)
        ? defaultEffort
        : efforts.includes('high') ? 'high' : efforts[0];
      dshMetadata.set(record.id, {
        dshReasoningEfforts: efforts,
        ...(selected ? { dshReasoningEffort: selected } : {}),
      });
    } else if (thinkingPolicy && defaultEffort) {
      dshMetadata.set(record.id, {
        dshThinkingPolicy: thinkingPolicy,
        dshReasoningEffort: defaultEffort,
      });
    }
  }
  return {
    ok: true,
    models: models.map((model) => ({ ...model, ...(dshMetadata.get(model.id) ?? {}) })),
  };
}
