import { UnsupportedResponsesFeatureError } from './types.js';

/**
 * 判定「确定性不支持的特性」错误。
 *
 * `instanceof` 只在同一份类对象上成立:跨模块引用或打包后若存在两份
 * @cindy/model-compat 实例,判定会失效,错误于是冒泡出本地桥接,被
 * anthropic-compat-proxy 兜底包成 HTTP 502 —— Codex 把 502 当成瞬态网关故障,
 * 反复重提同一个失败请求(自动续跑死循环,#9344)。这里同时按 name 判定,
 * 保证这类确定性错误一律落成 400 终态。
 */
export function isUnsupportedResponsesFeatureError(
  error: unknown,
): error is UnsupportedResponsesFeatureError {
  if (error instanceof UnsupportedResponsesFeatureError) return true;
  return error instanceof Error && error.name === 'UnsupportedResponsesFeatureError';
}

/**
 * 跨实例时 error.feature 可能缺失;日志只需要一个可读的字段名。
 */
export function unsupportedFeatureOf(error: UnsupportedResponsesFeatureError): string | undefined {
  const feature = (error as { feature?: unknown }).feature;
  return typeof feature === 'string' && feature ? feature : undefined;
}

/** Responses 错误体,与 Chat 桥接 handler 的 400 unsupported_feature 同口径。 */
export function unsupportedFeatureErrorBody(error: UnsupportedResponsesFeatureError): Record<string, unknown> {
  return {
    error: {
      type: 'invalid_request_error',
      code: 'unsupported_feature',
      message: error.message,
    },
  };
}
