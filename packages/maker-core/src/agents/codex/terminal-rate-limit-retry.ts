import {
  codexErrorInfoTag,
  type CodexErrorInfo,
} from './app-server/protocol.js';

/** Cindy 只在 daemon 自己的 retry budget 已耗尽后，再给短时 429 两次外层机会。 */
export const TERMINAL_RATE_LIMIT_RETRY_MAX_ATTEMPTS = 2;
/** 终态 429 外层重投的稳定 reason key；Desktop / Mobile 镜像同值。 */
export const TERMINAL_RATE_LIMIT_RETRY_REASON = 'terminal-rate-limit-retry';

const TERMINAL_RATE_LIMIT_RETRY_BASE_DELAY_MS = 15_000;
const TERMINAL_RATE_LIMIT_RETRY_MAX_DELAY_MS = 30_000;
const TERMINAL_RATE_LIMIT_RETRY_JITTER_RATIO = 0.25;

const RETRY_LIMIT_EXHAUSTED_PATTERN =
  /\b(?:exceeded\s+(?:the\s+)?retry\s+limit|retry\s+limit\s+exceeded|too\s+many\s+failed\s+attempts)\b/i;
const DETERMINISTIC_LIMIT_PATTERN =
  /\b(?:usage\s+limit|insufficient_quota|(?:session\s+)?budget\s+(?:exhausted|exceeded))\b/i;
const QUOTA_EXHAUSTION_PATTERN =
  /\b(?:quota\s+(?:(?:has|is|was)\s+)?(?:been\s+)?(?:exhausted|exceeded)|(?:exhausted|exceeded)\s+(?:(?:the|your)\s+)?(?:current\s+)?quota)\b/i;

function responseTooManyFailedAttemptsStatus(
  info: CodexErrorInfo | null | undefined,
): number | undefined {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  if (!('responseTooManyFailedAttempts' in info)) return undefined;
  const detail = info.responseTooManyFailedAttempts;
  return typeof detail?.httpStatusCode === 'number'
    ? detail.httpStatusCode
    : undefined;
}

/**
 * 是否是「daemon 已结束内部重试，最后一次仍为 429」的终态错误。
 *
 * `usageLimitExceeded` 是账号／套餐周期额度，短退避没有意义；即使文案也带 429，
 * 仍必须排除。老 daemon 没有结构化 tag 时，只接受明确的 retry-budget 耗尽文案，
 * 避免把普通 quota / rate-limit 错误一概重放。
 */
export function isTerminalRateLimitRetryExhaustion(
  message: string,
  errorStatus: number | undefined,
  info: CodexErrorInfo | null | undefined,
): boolean {
  const tag = codexErrorInfoTag(info);
  if (tag === 'usageLimitExceeded' || tag === 'sessionBudgetExceeded') return false;
  if (
    DETERMINISTIC_LIMIT_PATTERN.test(message) ||
    QUOTA_EXHAUSTION_PATTERN.test(message)
  ) {
    return false;
  }
  const status = responseTooManyFailedAttemptsStatus(info) ?? errorStatus;
  if (status !== 429) return false;
  return (
    tag === 'responseTooManyFailedAttempts' ||
    RETRY_LIMIT_EXHAUSTED_PATTERN.test(message)
  );
}

/** 第 attempt 次外层重投前的退避：15s、30s，带 ±25% jitter，单次不超过 30s。 */
export function terminalRateLimitRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    TERMINAL_RATE_LIMIT_RETRY_BASE_DELAY_MS * 2 ** exponent,
    TERMINAL_RATE_LIMIT_RETRY_MAX_DELAY_MS,
  );
  const factor =
    1 + (random() * 2 - 1) * TERMINAL_RATE_LIMIT_RETRY_JITTER_RATIO;
  return Math.min(
    Math.round(base * factor),
    TERMINAL_RATE_LIMIT_RETRY_MAX_DELAY_MS,
  );
}

/** 给终态 429 原文追加独立进度后缀，避免被下游误判成模型容量过载。 */
export function formatTerminalRateLimitRetryMessage(
  message: string,
  attempt: number,
  maxAttempts: number,
): string {
  return `${message} (rate-limit-retry ${attempt}/${maxAttempts})`;
}
