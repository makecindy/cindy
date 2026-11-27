/**
 * The range check of a task's context window budget in a session update patch: moved verbatim out of
 * updateSessionInDb (localDb/ipc/sessions.ts, which imports electron), which calls it where the check
 * stood. The Node Host's /sessions/update runs the same check before it writes a budget through
 * persistSessionFieldsWith, which itself drops an invalid budget silently.
 */
import { MAX_CONTEXT_WINDOW_BUDGET, MIN_CONTEXT_WINDOW_BUDGET } from '../../shared/sessionContextWindowBudget.js';
import { throwIpcError } from '../utils/ipcValidate';

/**
 * updateSessionInDb's budget check: an out-of-range budget is INVALID_PARAMS, never converged. An
 * assertion, so the caller's patch reads the budget as a number or null afterwards, as it did inline.
 */
export function assertSessionContextWindowBudgetPatch<P extends { contextWindowBudget?: unknown }>(
  p: P,
): asserts p is P & { contextWindowBudget?: number | null } {
    // 任务窗口预算：非法值不能静默 converge（normalize 会把 <1000 变成 null = 静默清预算、
    // 把超大值静默夹到上限），而调用方收到的是成功回包。隧道入口与本地入口必须同口径拒绝。
    if (
      p.contextWindowBudget !== undefined &&
      p.contextWindowBudget !== null &&
      (typeof p.contextWindowBudget !== 'number' ||
        !Number.isInteger(p.contextWindowBudget) ||
        p.contextWindowBudget < MIN_CONTEXT_WINDOW_BUDGET ||
        p.contextWindowBudget > MAX_CONTEXT_WINDOW_BUDGET)
    ) {
      throwIpcError(
        'INVALID_PARAMS',
        `contextWindowBudget must be null or an integer within [${MIN_CONTEXT_WINDOW_BUDGET}, ${MAX_CONTEXT_WINDOW_BUDGET}]`,
      );
    }
}
