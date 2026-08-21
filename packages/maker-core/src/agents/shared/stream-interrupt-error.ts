/**
 * 流式输出中途被掐断 —— LiteLLM / OpenAI Responses 前门把空壳
 * `error` / `response.failed` 事件填成 `Response API in-stream error`。
 *
 * **只负责识别与展示**，不驱动自动续跑。过载 / 网络类才走自动重试；
 * 这族错误在大上下文的 Grok 上常常连打几次仍失败，换模型才是逃生口。
 *
 * 消费方：
 *  - pi translator：终态 error 附带 `UPSTREAM_STREAM_INTERRUPTED_REASON`；
 *  - renderer ErrorBanner / ErrorMessageCard：人话替换 `OpenAI API error` 外壳。
 */

export const UPSTREAM_STREAM_INTERRUPTED_REASON = 'upstream-stream-interrupted';

/**
 * LiteLLM 在 Responses 流里收到没有 message 的 error 事件时写死的 fallback。
 * 这句足够独特，不认裸 `500` / 裸 `API error`。
 */
const STREAM_INTERRUPTED_RE = /Response API in-stream error/i;

/** 是否是 Responses / LiteLLM 流中途被掐的空壳错误。 */
export function isStreamInterruptedErrorMessage(message: string): boolean {
  return STREAM_INTERRUPTED_RE.test(message);
}
