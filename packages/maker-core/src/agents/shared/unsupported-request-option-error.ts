/**
 * Upstream 对「可选的请求增强字段」的确定性拒收（invalid_request_error）。
 *
 * 典型形态（Console Go / OpenCode Zen-Go 的 GLM 上游，2026-09-20）：
 * `"prompt_cache_retention" is not supported by this endpoint; use "prompt_cache_options"`。
 * 这类 400 不是网络/容量问题，原样重试必败；恢复动作是让 host 记住该 provider/model
 * 不接受该字段，改写 models.json 的 compat 后重放同一轮请求（PI provider compat 自愈）。
 *
 * 判据只认「被点名字段 + 明确的 not supported 措辞 + 上游给出的替代字段建议」三者
 * 同时出现：普通 400（鉴权/参数值错误）不满足，避免把不可自愈的确定性失败误收。
 */
export const UNSUPPORTED_REQUEST_OPTION_REASON = 'unsupported-request-option';

const RETENTION_FIELD_RE = /\bprompt_cache_retention\b/i;
const RETENTION_SUGGESTION_RE = /\bprompt_cache_options\b/i;
const NOT_SUPPORTED_RE = /not supported|unsupported|invalid_request_error/i;

export function isUnsupportedRequestOptionErrorMessage(message: string): boolean {
  return (
    typeof message === 'string' &&
    RETENTION_FIELD_RE.test(message) &&
    RETENTION_SUGGESTION_RE.test(message) &&
    NOT_SUPPORTED_RE.test(message)
  );
}

/**
 * 该错误在 PI models.json compat 上的修正。目前只有一种形态：上游不接受
 * `prompt_cache_retention` 长缓存提示，关闭它即可（隐式缓存与 prompt_cache_key 不受影响）。
 * undefined = 没有已知修正，调用方不得自愈。
 */
export function unsupportedRequestOptionCompatOverride(
  message: string,
): { supportsLongCacheRetention: false } | undefined {
  return isUnsupportedRequestOptionErrorMessage(message)
    ? { supportsLongCacheRetention: false }
    : undefined;
}
