/**
 * providerErrors.ts (shared, 跨进程) —— 供应商上游错误的结构化分类器（SSoT）。
 *
 * 消费方：
 *   - main / maker-host/provider-diagnostics.ts（设置页「测试连接」的结果判定）；
 *   - main / proxy host 的只读响应观察器（会话内上游错误 → 广播 PROVIDER_UPSTREAM_ERROR）；
 *   - renderer / utils（code → i18n 文案映射，`providerError.<code>` 键族）。
 *
 * 纯函数、零依赖：分类是确定性代码逻辑（规则 9），基于 HTTP status + 上游错误体的模式匹配。
 * pattern 覆盖 Anthropic / OpenAI 原生错误形状与常见兼容网关（litellm / OpenRouter / 各家
 * Anthropic 兼容端点）的措辞。新增 pattern 需要真实错误体为证，不凭推测加。
 */

/** 结构化错误码 —— renderer 按 `providerError.<code>` 取 i18n 文案。 */
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

export type ProviderErrorCode =
  /** 401：key 无效 / OAuth token 失效。 */
  | 'AUTH_INVALID'
  /** 403：key 有效但无权访问（区域 / 套餐 / 模型权限）。 */
  | 'AUTH_FORBIDDEN'
  /** 429 / 529：限流或过载，可重试。 */
  | 'RATE_LIMITED'
  /** 402 / 余额不足措辞：配额或余额耗尽。 */
  | 'QUOTA_EXCEEDED'
  /** 模型 id 不存在 / 无权使用该模型。 */
  | 'MODEL_NOT_FOUND'
  /** 404 且非模型问题：baseUrl 路径不对（端点不存在）。 */
  | 'ENDPOINT_NOT_FOUND'
  /** 上下文 / prompt 超长。 */
  | 'CONTEXT_TOO_LONG'
  /** 400 且命中「不认识的请求字段」类措辞：wire 兼容性问题（端点不完全兼容该协议）。 */
  | 'WIRE_INCOMPATIBLE'
  /** 5xx：上游服务端错误，可重试。 */
  | 'UPSTREAM_ERROR'
  /** 网络层不可达（DNS / 连接被拒 / 连接超时），可重试。 */
  | 'UPSTREAM_UNREACHABLE'
  /** 请求超时（探测 10s / 观察侧不产生此码）。 */
  | 'TIMEOUT'
  /** 无法归类。 */
  | 'UNKNOWN';

export interface ProviderErrorClassification {
  code: ProviderErrorCode;
  /** 是否值得原样重试（限流 / 网络抖动 / 上游 5xx）。 */
  retryable: boolean;
  /** 上游原始信息摘要（日志 / 详情展开用；UI 主文案走 i18n，不直接展示 detail）。 */
  detail?: string;
}

export interface ProviderErrorInput {
  /** HTTP 状态码；网络层失败时缺省。 */
  status?: number;
  /** 上游错误响应体文本（截断后传入即可，分类只看前几 KB）。 */
  bodyText?: string;
  /** 网络层错误码（ECONNREFUSED / ENOTFOUND / ETIMEDOUT / abort 等）。 */
  networkErrorCode?: string;
}

/** 网络层「不可达」错误码集合（Node fetch/undici 常见值）。 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** 超时类错误码（AbortSignal.timeout 抛 TimeoutError / AbortError）。 */
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ABORT_ERR', 'TimeoutError', 'AbortError']);

// ── 错误体 pattern（大小写不敏感；只在对应 status 分支内使用，避免误伤）───────────
/** 模型不存在 / 无权使用：Anthropic "model: xxx not found"、OpenAI "The model `x` does not exist"、
 *  litellm "Invalid model name"、通用 "model_not_found"。 */
const MODEL_NOT_FOUND_RE =
  /model[^\n]{0,80}(not.{0,4}(found|exist)|does not exist|invalid|unknown|unsupported)|model_not_found|invalid model/i;
/** 上下文超长：Anthropic "prompt is too long"、OpenAI "maximum context length"、通用 token limit 措辞。 */
const CONTEXT_TOO_LONG_RE =
  /prompt is too long|maximum context length|context.{0,20}(length|window).{0,40}(exceed|too)|too many tokens|input length.{0,20}exceed|context_length_exceeded/i;
/** 余额 / 配额：OpenAI "insufficient_quota"、通用 balance / credit 措辞。 */
const QUOTA_RE = /insufficient_quota|insufficient.{0,12}(balance|credit|funds)|quota.{0,20}exceed|余额不足|欠费/i;
/** wire 兼容性：端点不认识请求里的字段 / 参数（典型：litellm/Azure 对 Anthropic-only 字段报错）。 */
const WIRE_RE =
  /(unknown|unexpected|unsupported|extra|unrecognized).{0,16}(field|parameter|argument|inputs?|property|request param)|extra inputs are not permitted|invalid_request_error[^\n]{0,120}(field|param)/i;
/** 鉴权失败措辞（个别网关 401 语义但回 400/403 文本）。 */
const AUTH_RE = /invalid.{0,10}(api.?key|token)|authentication_error|unauthorized|api key not valid|令牌|鉴权失败/i;

/**
 * 分类一次供应商上游失败。确定性纯函数：同输入必同输出。
 * 优先级：网络层错误 > 明确 status > 错误体 pattern > UNKNOWN。
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClassification {
  const { status, networkErrorCode } = input;
  const body = (input.bodyText ?? '').slice(0, 4096);
  const detail = body ? redactSensitiveText(body.slice(0, 500)) : undefined;

  if (networkErrorCode) {
    if (TIMEOUT_CODES.has(networkErrorCode)) return { code: 'TIMEOUT', retryable: true, detail: networkErrorCode };
    if (UNREACHABLE_CODES.has(networkErrorCode)) {
      return { code: 'UPSTREAM_UNREACHABLE', retryable: true, detail: networkErrorCode };
    }
    // 不认识的网络层错误码不硬归「不可达」——错误引导用户「检查网络」比承认「未知错误」更糟。
    return { code: 'UNKNOWN', retryable: false, detail: networkErrorCode };
  }

  if (status === undefined) return { code: 'UNKNOWN', retryable: false, detail };

  if (status === 401) return { code: 'AUTH_INVALID', retryable: false, detail };
  if (status === 402) return { code: 'QUOTA_EXCEEDED', retryable: false, detail };
  if (status === 403) {
    // 部分网关把 key 无效也报 403 —— 命中鉴权措辞时归 AUTH_INVALID（提示用户重填 key 更可行动）。
    if (AUTH_RE.test(body)) return { code: 'AUTH_INVALID', retryable: false, detail };
    return { code: 'AUTH_FORBIDDEN', retryable: false, detail };
  }
  if (status === 429 || status === 529) return { code: 'RATE_LIMITED', retryable: true, detail };
  if (status === 404) {
    if (MODEL_NOT_FOUND_RE.test(body)) return { code: 'MODEL_NOT_FOUND', retryable: false, detail };
    return { code: 'ENDPOINT_NOT_FOUND', retryable: false, detail };
  }
  if (status === 400 || status === 422) {
    if (MODEL_NOT_FOUND_RE.test(body)) return { code: 'MODEL_NOT_FOUND', retryable: false, detail };
    if (CONTEXT_TOO_LONG_RE.test(body)) return { code: 'CONTEXT_TOO_LONG', retryable: false, detail };
    if (QUOTA_RE.test(body)) return { code: 'QUOTA_EXCEEDED', retryable: false, detail };
    if (AUTH_RE.test(body)) return { code: 'AUTH_INVALID', retryable: false, detail };
    if (WIRE_RE.test(body)) return { code: 'WIRE_INCOMPATIBLE', retryable: false, detail };
    return { code: 'UNKNOWN', retryable: false, detail };
  }
  if (status >= 500) return { code: 'UPSTREAM_ERROR', retryable: true, detail };

  return { code: 'UNKNOWN', retryable: false, detail };
}
