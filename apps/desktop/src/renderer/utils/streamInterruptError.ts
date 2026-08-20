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

/**
 * 兜底展示时剥掉协议客户端前缀。Pi 的 Responses 客户端不分厂商,
 * 一律写成 `OpenAI API error`;LiteLLM 再套一层 JSON。只改展示,不改落盘。
 */
export function unwrapProviderErrorDisplay(message: string): string {
  let text = message.trim();
  const hadOpenAiPrefix = OPENAI_API_ERROR_PREFIX.test(text);
  text = text.replace(OPENAI_API_ERROR_PREFIX, '');
  if (hadOpenAiPrefix && text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'message' in parsed &&
        typeof (parsed as { message: unknown }).message === 'string'
      ) {
        const inner = (parsed as { message: string }).message.trim();
        if (inner.length > 0) text = inner;
      }
    } catch {
      // 不是 JSON 就保留剥前缀后的原文。
    }
  }
  // 只剥 OpenAI 协议外壳里套的 litellm.XxxError,不要动裸的 LiteLLM 文案
  // (例如余额不足仍要让 ErrorBanner 按原文分类)。
  if (hadOpenAiPrefix) text = text.replace(LITELLM_ERROR_PREFIX, '');
  return text.length > 0 ? text : message;
}
