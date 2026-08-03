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
/** 明确的余额 / 预算耗尽措辞：即使外层同时带 RateLimitError，也不得
 *  被速率限额排除。LiteLLM 的实际形状会把 BudgetExceededError 包在
 *  RateLimitError 里(review P1)。 */
const EXPLICIT_DEPLETION_RE =
  /insufficient_quota|insufficient.{0,12}(balance|credit|funds)|\bcredit(?:s| balance)?\s+(?:depleted|exhausted|too low)\b|budget.{0,20}exceeded|ExceededBudget|余额不足|欠费/i;
/** 单独出现的 quota exceeded 可能是余额配额，也可能是每分钟 / token 速率配额。 */
const AMBIGUOUS_QUOTA_RE = /quota.{0,20}exceed/i;
/** 速率型配额措辞(每分钟/每秒请求或 token 上限,如 Google "Quota exceeded for quota
 *  metric 'requests per minute'"、紧凑斜杠写法 "100 requests/minute"、
 *  "1M tokens/day"、缩写斜杠写法 "100 requests/min"、"500 tokens/sec"、单字母斜杠
 *  写法 "100 tokens/s"、速率缩写 RPS/RPM/RPH/RPD 与 TPS/TPM/TPH/TPD):
 *  也含 quota exceeded 字样,但等待重试即可恢复,**不是**
 *  余额/预算耗尽——不得判成不可重试的 QUOTA_EXCEEDED,更不得触发充值引导
 *  (review P1 ×5)。 */
const RATE_QUOTA_RE =
  /per\s+(second|minute|hour|day)|per-(second|minute|hour|day)|\/(second|minute|hour|day|sec|min|hr|s)\b|\b[rt]p[smhd]\b|quota metric|rate.{0,8}limit/i;
/** makerChatStore 会把结构化 errorStatus 保留为原文中的状态码或 `(HTTP N)` 后缀。 */
const HTTP_402_MESSAGE_RE =
  /(?:^\s*402\b|\bHTTP\s*402\b|\b(?:status|error)\s+code\s*[:=]?\s*402\b|\bstatus\s*[:=]?\s*402\b)/i;
/** wire 兼容性：端点不认识请求里的字段 / 参数（典型：litellm/Azure 对 Anthropic-only 字段报错）。 */
const WIRE_RE =
  /(unknown|unexpected|unsupported|extra|unrecognized).{0,16}(field|parameter|argument|inputs?|property|request param)|extra inputs are not permitted|invalid_request_error[^\n]{0,120}(field|param)/i;
/** 鉴权失败措辞（个别网关 401 语义但回 400/403 文本）。 */
const AUTH_RE =
  /invalid.{0,10}(api.?key|token)|authentication_error|unauthorized|api key not valid|令牌|鉴权失败/i;

/**
 * 消息级「余额 / 配额耗尽」判定:给只有错误文本、拿不到 HTTP status 的消费方用
 * (会话 ErrorBanner 的 turn 错误是 agent 透传的字符串)。正文为空或只有通用
 * Payment Required 时,识别 makerChatStore 从结构化 errorStatus 保留的 402:
 * 原文已有状态码时 store 不重复追加,否则会加 `(HTTP 402)` 后缀,两种形态都
 * 必须覆盖。其它情况与 classifyProviderError 的 QUOTA_EXCEEDED 共用同一
 * pattern,避免两处口径漂移。
 */
export function isQuotaExceededMessage(text: string): boolean {
  return (
    HTTP_402_MESSAGE_RE.test(text) ||
    EXPLICIT_DEPLETION_RE.test(text) ||
    (AMBIGUOUS_QUOTA_RE.test(text) && !RATE_QUOTA_RE.test(text))
  );
}

/**
 * 分类一次供应商上游失败。确定性纯函数：同输入必同输出。
 * 优先级：网络层错误 > 明确 status > 错误体 pattern > UNKNOWN。
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClassification {
  const { status, networkErrorCode } = input;
  const body = (input.bodyText ?? '').slice(0, 4096);
  const detail = body ? redactSensitiveText(body.slice(0, 500)) : undefined;

  if (networkErrorCode) {
    if (TIMEOUT_CODES.has(networkErrorCode))
      return { code: 'TIMEOUT', retryable: true, detail: networkErrorCode };
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
  if (status === 429 || status === 529) {
    // LiteLLM 会用 429 携带 ExceededBudget(预算耗尽):这是不可重试的余额问题,
    // 不能落进「限流,可重试」误导用户空转。
    if (isQuotaExceededMessage(body)) return { code: 'QUOTA_EXCEEDED', retryable: false, detail };
    return { code: 'RATE_LIMITED', retryable: true, detail };
  }
  if (status === 404) {
    if (MODEL_NOT_FOUND_RE.test(body)) return { code: 'MODEL_NOT_FOUND', retryable: false, detail };
    return { code: 'ENDPOINT_NOT_FOUND', retryable: false, detail };
  }
  if (status === 400 || status === 422) {
    if (MODEL_NOT_FOUND_RE.test(body)) return { code: 'MODEL_NOT_FOUND', retryable: false, detail };
    if (CONTEXT_TOO_LONG_RE.test(body))
      return { code: 'CONTEXT_TOO_LONG', retryable: false, detail };
    if (isQuotaExceededMessage(body)) return { code: 'QUOTA_EXCEEDED', retryable: false, detail };
    if (AUTH_RE.test(body)) return { code: 'AUTH_INVALID', retryable: false, detail };
    if (WIRE_RE.test(body)) return { code: 'WIRE_INCOMPATIBLE', retryable: false, detail };
    return { code: 'UNKNOWN', retryable: false, detail };
  }
  if (status >= 500) return { code: 'UPSTREAM_ERROR', retryable: true, detail };

  return { code: 'UNKNOWN', retryable: false, detail };
}
