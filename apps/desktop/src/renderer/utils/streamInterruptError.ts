/**
 * 流式输出中途被掐断(renderer 侧)。ErrorBanner 用它把
 * `OpenAI API error (500): … Response API in-stream error` 换成友好文案,
 * 原文折叠可查。不跨 bundle 共享 maker-core 代码,与 overload / network 同款惯例。
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

function isLiteLlmEnvelope(text: string): boolean {
  return /litellm\./i.test(text) || LITELLM_ERROR_PREFIX.test(text);
}

function unwrapLiteLlmInner(text: string): string {
  const stripped = text.replace(LITELLM_ERROR_PREFIX, '').trim();
  return stripped.length > 0 ? stripped : text;
}

/**
 * 兜底展示时剥掉 **LiteLLM 套在 OpenAI Responses 客户端上的协议外壳**。
 * Pi 的 Responses 客户端不分厂商,一律写成 `OpenAI API error`;LiteLLM 再套 JSON。
 * 真 OpenAI / Azure OpenAI 错误保留前缀与状态码。只改展示,不改落盘。
 */
export function unwrapProviderErrorDisplay(message: string): string {
  const text = message.trim();
  const prefixMatch = text.match(OPENAI_API_ERROR_PREFIX);
  if (!prefixMatch) return text.length > 0 ? text : message;

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
          return unwrapLiteLlmInner(inner);
        }
      }
    } catch {
      // 不是 JSON 就落到下面的 litellm.XxxError 直配。
    }
  }

  if (isLiteLlmEnvelope(rest)) return unwrapLiteLlmInner(rest);
  return message;
}
