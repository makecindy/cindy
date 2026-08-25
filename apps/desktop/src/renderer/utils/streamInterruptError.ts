/**
 * 流式输出中途被掐断(renderer 侧)。ErrorBanner 用它把
 * `OpenAI API error (500): … Response API in-stream error` 换成友好文案,
 * 原文折叠可查。不跨 bundle 共享 maker-core 代码,与 overload / network 同款惯例。
 *
 * 同文件还负责把 LiteLLM / xAI 套在 OpenAI Responses 外壳里的 400
 * 拆到内层 message,并识别 Grok「Upstream rejected」这族看图拒请求。
 */

export const UPSTREAM_STREAM_INTERRUPTED_REASON = 'upstream-stream-interrupted';

const STREAM_INTERRUPTED_RE = /Response API in-stream error/i;

export function isStreamInterruptedErrorMessage(
  message: string,
  reason?: string | null,
): boolean {
  if (reason === UPSTREAM_STREAM_INTERRUPTED_REASON) return true;
  return STREAM_INTERRUPTED_RE.test(message);
}

const OPENAI_API_ERROR_PREFIX = /^(?:Azure )?OpenAI API error \(\d+\):\s*/i;
const LITELLM_ERROR_PREFIX = /^litellm\.\w+Error:\s*/;
const VENDOR_JSON_EXCEPTION_RE = /^([A-Za-z][\w.]*)\s*-\s*(\{[\s\S]*\})$/;
const XAI_UPSTREAM_REJECTED_RE = /XaiException[\s\S]*Upstream rejected the request/i;
const MAX_UNWRAP_DEPTH = 5;

function isLiteLlmEnvelope(text: string): boolean {
  return LITELLM_ERROR_PREFIX.test(text) || /^litellm\./i.test(text);
}

function unwrapLiteLlmInner(text: string): string {
  const stripped = text.replace(LITELLM_ERROR_PREFIX, '').trim();
  return stripped.length > 0 ? stripped : text;
}

function extractErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > MAX_UNWRAP_DEPTH || value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        return extractErrorMessage(JSON.parse(trimmed), depth + 1) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    const peeled = peelVendorJsonPayload(trimmed);
    if (peeled !== trimmed) {
      return extractErrorMessage(peeled, depth + 1) ?? peeled;
    }
    return trimmed;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ('error' in obj) {
      const fromError = extractErrorMessage(obj.error, depth + 1);
      if (fromError) return fromError;
    }
    if (typeof obj.message === 'string') {
      return extractErrorMessage(obj.message, depth + 1);
    }
  }
  return null;
}

/** `XaiException - {json}` → 内层 error.message；非 JSON 后缀原样保留。 */
function peelVendorJsonPayload(text: string): string {
  const match = text.match(VENDOR_JSON_EXCEPTION_RE);
  if (!match) return text;
  try {
    const inner = extractErrorMessage(JSON.parse(match[2]));
    return inner && inner.length > 0 ? inner : text;
  } catch {
    return text;
  }
}

/**
 * 兜底展示时剥掉 **LiteLLM 套在 OpenAI Responses 客户端上的协议外壳**。
 * Pi 的 Responses 客户端不分厂商,一律写成 `OpenAI API error`;LiteLLM 再套 JSON。
 * 真 OpenAI / Azure OpenAI 错误保留前缀与状态码。只改展示,不改落盘。
 */
export function unwrapProviderErrorDisplay(message: string): string {
  const text = message.trim();
  const prefixMatch = text.match(OPENAI_API_ERROR_PREFIX);
  if (!prefixMatch) {
    return peelVendorJsonPayload(text.length > 0 ? text : message);
  }

  const rest = text.slice(prefixMatch[0].length).trim();
  if (rest.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(rest);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'message' in parsed &&
        typeof (parsed as { message: unknown }).message === 'string'
      ) {
        const inner = (parsed as { message: string }).message.trim();
        if (inner.length > 0 && isLiteLlmEnvelope(inner)) {
          return peelVendorJsonPayload(unwrapLiteLlmInner(inner));
        }
      }
    } catch {
      // 不是 JSON 就落到下面的 litellm.XxxError 直配。
    }
  }

  if (isLiteLlmEnvelope(rest)) return peelVendorJsonPayload(unwrapLiteLlmInner(rest));
  return message;
}

/**
 * Grok / xAI 对非法看图或非法请求体回的空壳 400。
 * 原文被 Pi 写成 OpenAI API error、LiteLLM 再套 XaiException,用户看不到原因。
 */
export function isXaiInvalidRequestError(message: string): boolean {
  return XAI_UPSTREAM_REJECTED_RE.test(message);
}
