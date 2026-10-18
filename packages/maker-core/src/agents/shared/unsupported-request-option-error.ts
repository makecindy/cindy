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
 * 普通 400（鉴权/参数值错误/未点名已知字段）不满足；结构化错误里出现 `param` 时，
 * 它必须点名这两类字段之一，避免把别的参数错误误判成「不支持」。
 */
export const UNSUPPORTED_REQUEST_OPTION_REASON = 'unsupported-request-option';

/**
 * `PI_CACHE_RETENTION=long` 下 Pi 会一起发给 openai-completions 端点的两个字段：
 * 档位本身（prompt_cache_retention）与随之派生的路由键（prompt_cache_key）。
 * Pi 1.0.2 实测：compat 关掉 supportsLongCacheRetention 后二者一起消失
 * （见 packages/maker-core/src/agents/pi/__tests__/pi-provider-routing.test.ts
 *  与 issue #5878 的运行记录），所以同一个修正即可覆盖两种拒收文案。
 */
const CACHE_FIELDS = ['prompt_cache_retention', 'prompt_cache_key'] as const;
// `\b` 边界防止误匹配 prompt_cache_keyword / prompt_cache_retention_policy 之类的长字段。
const CACHE_FIELD_RE = /\bprompt_cache_(?:retention|key)\b/i;
const NOT_SUPPORTED_RE = /not\s+supported|unsupported|isn't\s+supported|does\s+not\s+support/i;
const STRUCTURED_PARAM_RE = /"param"\s*:\s*"([^"]*)"/i;

export function isUnsupportedRequestOptionErrorMessage(message: string): boolean {
  if (typeof message !== 'string' || message.length === 0) return false;
  if (!CACHE_FIELD_RE.test(message)) return false;
  const param = STRUCTURED_PARAM_RE.exec(message)?.[1];
  if (param !== undefined && !CACHE_FIELDS.some((field) => field === param.toLowerCase())) return false;
  return NOT_SUPPORTED_RE.test(message);
}

/**
 * 该错误在 PI models.json compat 上的修正。目前只有一种形态：上游不接受缓存扩展字段，
 * 关闭长缓存档位即可（隐式缓存与 prompt_cache_key 一并不再发送，见上方实测）。
 * undefined = 没有已知修正，调用方不得自愈。
 */
export function unsupportedRequestOptionCompatOverride(
  message: string,
): { supportsLongCacheRetention: false } | undefined {
  return isUnsupportedRequestOptionErrorMessage(message)
    ? { supportsLongCacheRetention: false }
    : undefined;
}
