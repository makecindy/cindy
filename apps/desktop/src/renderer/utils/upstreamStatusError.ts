/**
 * 上游返回了 HTTP 错误状态、但没带错误正文(renderer 侧)。
 *
 * 这类错误(常见于 Pi 自建中转的 "550 status code (no body)")既不是网络
 * 不可达,也不是模型容量不足,但 ErrorBanner 的兜底文案只会显示通用的
 * 「回复未完成」,用户看不出是上游拒了。识别出状态码后,横幅标题直接写明
 * 上游返回的状态,原始报错仍折叠在详情里。
 *
 * 只认 5xx:4xx 多半是请求本身的问题(配额、上下文超限),那些各有专属分支,
 * 不在这里抢。只取状态码本身,不解析、不外传正文。
 */

export interface UpstreamStatusError {
  /** 上游返回的 HTTP 状态,例如 "550"。 */
  status: string;
}

const UPSTREAM_STATUS_ERROR_RE = /\b(5\d{2})\s+status code\b/i;

export function parseUpstreamStatusError(message: string): UpstreamStatusError | null {
  const match = UPSTREAM_STATUS_ERROR_RE.exec(message);
  if (!match) return null;
  return { status: match[1] };
}
