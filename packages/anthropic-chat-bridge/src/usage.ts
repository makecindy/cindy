/**
 * usage 映射 —— OpenAI Chat Completions usage → Anthropic Messages usage。
 *
 * Chat:  { prompt_tokens(含 cached), completion_tokens, total_tokens,
 *         prompt_tokens_details:{cached_tokens}(部分厂商), ... }
 * Anthropic:  { input_tokens(不含 cache_read), output_tokens,
 *               cache_read_input_tokens, cache_creation_input_tokens }
 *
 * 与 anthropic-responses-bridge 的 mapUsage 同口径:Anthropic 的 input_tokens **不含**
 * cache_read,而 Chat 的 prompt_tokens 通常**含** cached;所以 input_tokens =
 * prompt_tokens - cached_tokens,cache_read_input_tokens = cached_tokens。
 * output_tokens 直接透传(已含 reasoning,正是要计费的)。
 */

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function mapUsage(chatUsage: unknown): AnthropicUsage {
  const u = (chatUsage ?? {}) as Record<string, unknown>;
  const promptTokens = num(u.prompt_tokens);
  // 兼容两种形态:OpenAI 官方 prompt_tokens_details.cached_tokens,以及部分厂商
  // 直接把缓存部分摊进 prompt_tokens 明细的变体;都拿不到则按 0(诚实降级)。
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(details.cached_tokens);
  return {
    input_tokens: Math.max(0, promptTokens - cached),
    output_tokens: num(u.completion_tokens),
    cache_read_input_tokens: cached,
    // Chat 系上游没有显式「写缓存」的计费概念(cache_creation 只存在于 Anthropic
    // 原生),恒 0 —— 与 anthropic-responses-bridge 同口径。
    cache_creation_input_tokens: 0,
  };
}
