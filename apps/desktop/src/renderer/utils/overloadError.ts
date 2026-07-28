/**
 * 服务过载类错误识别(renderer 侧)— 判断错误 message 是不是"上游模型服务没有
 * 可用容量",以及它当前是否正在自动重试。ErrorBanner 用它把原始英文报错
 * (如 "Selected model is at capacity. Please try a different model.")换成友好
 * 文案,原始错误折叠可查。
 *
 * 判定与 maker-core 的 `packages/maker-core/src/agents/shared/overload-error.ts`
 * **语义一致**(那份决定 Codex 是否退避重投、进度后缀怎么编码;不跨 bundle 共享
 * 代码,与 network-error / 401 pattern 的两端一致性同款惯例)。修改时两处同步。
 *
 * **与 networkError.ts 的分工**:那份管"网络到不了上游"(网关 5xx、errno、fetch
 * 失败),本份管"网络通了、上游明确说自己没容量"。两者文案不同——把容量问题显示
 * 成"网络异常"会让用户白折腾自己的网络。
 *
 * 两种形态:
 *  - `capacity`:Codex 透传 OpenAI 的 `Selected model is at capacity`。
 *    app-server 侧不重试,由 maker-core 接管退避重投。
 *  - `overloaded`:Anthropic HTTP 529。Claude Code SDK 自己带退避重试,客户端
 *    只负责显示进度。
 */

export type OverloadErrorKind = 'capacity' | 'overloaded';

export function parseOverloadError(
  message: string,
  errorStatus?: number,
): { kind: OverloadErrorKind } | null {
  if (errorStatus === 529) return { kind: 'overloaded' };
  if (/\bat capacity\b/i.test(message)) return { kind: 'capacity' };
  if (/\boverloaded_error\b|\b529\b/.test(message)) return { kind: 'overloaded' };
  return null;
}

export function isOverloadErrorMessage(message: string, errorStatus?: number): boolean {
  return parseOverloadError(message, errorStatus) !== null;
}

/**
 * 解析重投进度后缀 `(auto-retry N/M)`(由 maker-core 的
 * `formatOverloadRetryMessage` 追加,两个 agent 共用同一套编码)。
 *
 * 返回 null = 没有进度后缀,即"已经放弃重试"(退避耗尽后的终止错误,或上游原样
 * 报错)。这个区分决定 banner 显示"正在重试"还是"请改用其它模型"。
 */
const OVERLOAD_RETRY_PROGRESS_RE = /\(auto-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/;

export function parseOverloadRetryProgress(
  message: string,
): { attempt: number; maxAttempts: number } | null {
  const match = OVERLOAD_RETRY_PROGRESS_RE.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxAttempts) ||
    attempt < 1 ||
    maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, maxAttempts };
}
