/**
 * Upstream 对「可选的请求增强字段」的确定性拒收（invalid_request_error）。
 *
 * 已确认的两种形态：
 * 1. Console Go / OpenCode Zen-Go 的 GLM 上游（2026-09-20）：
 *    `"prompt_cache_retention" is not supported by this endpoint; use "prompt_cache_options"`。
 * 2. 政企/内网自定义 OpenAI 兼容网关（issue #5878，2026-10-12，Pi 1.0.2 实测复现）：
 *    `Validation: Unsupported parameter(s): `prompt_cache_key``。
 *
 * 两种都是 400 而非网络/容量问题，原样重试必败；恢复动作是让 host 记住该 provider/model
 * 不接受该字段，改写 models.json 的 compat 后重放同一轮请求（PI provider compat 自愈）。
 *
 * 判据只认「被点名的可选字段 + 明确的 not supported/unsupported 措辞」同时出现：
 * 普通 400（鉴权/参数值错误/未点名已知字段）不满足；结构化错误的 `param` 缺省或为 null
 * 表示未指定参数；非 null 时必须点名这两类字段之一，避免误判其他参数错误。
 */
export const UNSUPPORTED_REQUEST_OPTION_REASON = 'unsupported-request-option';

/**
 * `PI_CACHE_RETENTION=long` 下 Pi 会一起发给 openai-completions 端点的两个字段：
 * 档位本身（prompt_cache_retention）与随之派生的路由键（prompt_cache_key）。
 * Pi 1.0.2 普通 URL 下 compat 会移除二者；包含 api.openai.com 的 URL 仍可发送 key。
 * Host 同时为精确命中的路由生成请求 hook 规则；真实 RPC/HTTP 回归覆盖两种 URL。
 */
const CACHE_FIELDS = ['prompt_cache_retention', 'prompt_cache_key'] as const;
// `\b` 边界防止误匹配 prompt_cache_keyword / prompt_cache_retention_policy 之类的长字段。
const CACHE_FIELD_RE = /\bprompt_cache_(?:retention|key)\b/i;
// A relationship in the same short clause, not two keywords anywhere in the error.
const REJECTED_FIELD_RE = /(?:unsupported\s+(?:request\s+)?parameters?(?:\(s\))?\s*:\s*[\x60"'\\\s]*(prompt_cache_(?:retention|key))\b|\b(prompt_cache_(?:retention|key))\b[\x60"'\\\s]*(?:is\s+(?:not\s+supported|unsupported)|isn't\s+supported))/i;

export function isUnsupportedRequestOptionErrorMessage(message: string): boolean {
  if (typeof message !== 'string' || message.length === 0 || message.length > 64 * 1024) return false;
  const status = /^\s*(\d{3})\s*:/.exec(message);
  if (status && status[1] !== '400') return false;
  let text = message;
  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      let value: unknown = JSON.parse(message.slice(jsonStart));
      for (let depth = 0; depth < 3; depth++) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const error = value as Record<string, unknown>;
        if (Object.hasOwn(error, 'param') && error.param !== null && !CACHE_FIELDS.some((field) => field === error.param)) return false;
        if (error.type !== undefined && !['invalid_request_error', 'unsupported_parameter'].includes(String(error.type))) return false;
        if (typeof error.message === 'string') { text = error.message; break; }
        value = error.error;
      }
    } catch { return false; }
  }
  return CACHE_FIELD_RE.test(text) && REJECTED_FIELD_RE.test(text);
}

/**
 * 该错误在 PI models.json compat 上的修正。目前只有一种形态：上游不接受缓存扩展字段，
 * 关闭长缓存档位，并由精确路由的请求 hook 补齐残留字段处理。
 * undefined = 没有已知修正，调用方不得自愈。
 */
export function unsupportedRequestOptionCompatOverride(
  message: string,
): { supportsLongCacheRetention: false } | undefined {
  return isUnsupportedRequestOptionErrorMessage(message)
    ? { supportsLongCacheRetention: false }
    : undefined;
}
