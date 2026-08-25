/**
 * 流式输出中途被掐断(renderer 侧)。ErrorBanner 用它把
 * `OpenAI API error (500): … Response API in-stream error` 换成友好文案,
 * 原文折叠可查。不跨 bundle 共享 maker-core 代码,与 overload / network 同款惯例。
 *
 * 同文件把 LiteLLM / OpenAI Responses 套在厂商错误外的协议外壳剥掉,
 * 展示上游内层原文。只改展示,不改写原因、不落盘。
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
 * 剥掉 LiteLLM 套在 OpenAI Responses 客户端上的协议外壳,留下上游原文。
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
