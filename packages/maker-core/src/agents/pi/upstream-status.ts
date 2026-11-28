/**
 * 上游 RPC 错误里的 HTTP 状态（"550 status code (no body)" 这类）。
 *
 * 只取状态码本身：错误正文可能带着任务内容，绝不外传。放在独立模块里，
 * 不进 rpc-client —— 多个 Pi 用例会整体 mock 掉那个模块。
 */
export function piUpstreamStatus(error: string | undefined): number | undefined {
  if (!error) return undefined;
  const match = /\b([45]\d{2})\s+status code\b/i.exec(error);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}
