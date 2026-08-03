/**
 * Codex daemon 耗尽内部 retry budget 后，maker-core 接管终态 429 时使用的
 * renderer 契约。reason 与进度 marker 必须同时命中，避免把普通 429 或模型容量
 * 过载误归类成这条外层重投路径。
 *
 * maker-core 侧同名常量与 formatter 位于
 * `packages/maker-core/src/agents/codex/terminal-rate-limit-retry.ts`；两端不跨 bundle
 * 共享代码，修改契约时必须同步。
 */
export const TERMINAL_RATE_LIMIT_RETRY_REASON = 'terminal-rate-limit-retry';

const TERMINAL_RATE_LIMIT_RETRY_PROGRESS_RE = /\(rate-limit-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/;

export function parseTerminalRateLimitRetryProgress(
  message: string,
  reason?: string | null,
): { attempt: number; maxAttempts: number } | null {
  if (reason !== TERMINAL_RATE_LIMIT_RETRY_REASON) return null;
  const match = TERMINAL_RATE_LIMIT_RETRY_PROGRESS_RE.exec(message);
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
