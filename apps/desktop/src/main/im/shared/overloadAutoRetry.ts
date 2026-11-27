/**
 * im/shared/overloadAutoRetry.ts
 * ---------------------------------------------------------------------------
 * 官方 Hook（hook-control/session-runner）与个人 IM（im/shared/turnRunner）
 * 共用的上游容量过载（`upstream-overload` / 529 / `at capacity`）外层自动重试判定。
 *
 * 背景：
 * - Desktop 经 `AgentInputCoordinator` 派发的任务在遇到终态 `upstream-overload`
 *   （例如本 turn 已有工具调用或部分正文输出，maker-core 刻意拒绝原地重放而发终态
 *   error）时，会由 `interruptedTurnAutoResume` 自动重试并在多账号池场景下通过
 *   `prepareUnhealthySessionForSend` 切换到同池健康账号续跑。
 * - 官方 Hook 与个人 IM 直接调 `session.send`，绕开了 `AgentInputCoordinator`，此前
 *   对终态 `upstream-overload` 一律直接失败，既不重试也不切换同池健康账号。
 *
 * 边界约束：
 * - 大写 `UPSTREAM_OVERLOADED` 仅用于展示文案本地化（telegram-bot-parity.md），
 *   绝不触发自动重试。
 * - 零产出且底层引擎已做过就地过载重试、同时同池没有可切换账号时，不再叠加一轮
 *   外层重试，避免对已过载单号重复放大请求。
 * - 已有产出（文本/工具/思考）的重试必须发送 `CONTINUE_AFTER_ERROR_PROMPT`，绝不重放
 *   原用户消息（防重复工具副作用）。
 */

import { UPSTREAM_OVERLOAD_REASON } from '@cindy/maker-core';
import { classifyTurnOverload } from '../../goal-host/usageLimit.js';
import { readInterruptedTurnAutoResumeSettings } from '../../maker-host/interrupted-turn-auto-resume-store.js';
import { interruptedTurnResumeDelayMs } from '../../maker-ipc/interruptedTurnAutoResume.js';
import { imText } from './imText.js';

/** 渠道外层过载自动重试上限（与 maker-core 过载退避同量级）。 */
export const CHANNEL_OVERLOAD_RETRY_MAX_ATTEMPTS = 4;

/**
 * 同池存在可切换的健康账号时的短延迟（ms）。
 * 留出底层 session 完成终态收尾（`isTurnRunning()` 归 false）的窗口后立即切号重试，
 * 不走同号长退避。
 */
export const CHANNEL_OVERLOAD_ACCOUNT_SWITCH_DELAY_MS = 1_500;

function isOverloadAutoRetryEnabled(): boolean {
  try {
    return readInterruptedTurnAutoResumeSettings().enabled;
  } catch {
    // 非 Electron 完整环境（例如未 mock app.getPath 的单测）沿用默认开启。
    return true;
  }
}

/** 终态错误是否属于允许渠道层自动重试的上游容量过载。 */
export function isChannelOverloadRetryable(
  errorData: unknown,
  errorReason?: string | null,
): boolean {
  if (!isOverloadAutoRetryEnabled()) return false;
  const dataReason =
    errorData &&
    typeof errorData === 'object' &&
    'reason' in errorData &&
    typeof (errorData as { reason?: unknown }).reason === 'string'
      ? (errorData as { reason: string }).reason
      : null;
  const reason = errorReason ?? dataReason;
  // 大写 UPSTREAM_OVERLOADED 是展示态映射 reason（telegram-bot-parity.md），绝不触发重试。
  if (reason === 'UPSTREAM_OVERLOADED') return false;
  return reason === UPSTREAM_OVERLOAD_REASON || classifyTurnOverload(errorData);
}

/** 结合已尝试次数、是否有产出、底层是否已重试以及能否同池换号，决定本次是否继续自动重试。 */
export function shouldRetryChannelOverload(input: {
  errorData: unknown;
  errorReason?: string | null;
  attempt: number;
  maxAttempts?: number;
  hasOutput: boolean;
  hadInTurnOverloadRetry: boolean;
  canSwitchAccount: boolean;
}): boolean {
  const maxAttempts = input.maxAttempts ?? CHANNEL_OVERLOAD_RETRY_MAX_ATTEMPTS;
  if (input.attempt >= maxAttempts) return false;
  if (!isChannelOverloadRetryable(input.errorData, input.errorReason)) return false;
  if (!input.hasOutput && input.hadInTurnOverloadRetry && !input.canSwitchAccount) {
    return false;
  }
  return true;
}

/** 第 `attempt` 次重试前的等待时长（attempt 从 1 起）。可换号时用短延迟，否则指数退避。 */
export function channelOverloadRetryDelayMs(
  attempt: number,
  canSwitchAccount: boolean,
  random: () => number = Math.random,
): number {
  if (canSwitchAccount) return CHANNEL_OVERLOAD_ACCOUNT_SWITCH_DELAY_MS;
  return interruptedTurnResumeDelayMs(attempt, random);
}

/** 渠道过程区的过载自动重试状态行。 */
export function formatChannelOverloadRetryNotice(
  attempt: number,
  maxAttempts = CHANNEL_OVERLOAD_RETRY_MAX_ATTEMPTS,
): string {
  return imText('imBot.text.shared.retry.overloadRetrying', { attempt, maxAttempts });
}
