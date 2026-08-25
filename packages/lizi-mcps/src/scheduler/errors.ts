/**
 * scheduler/errors.ts
 *
 * Translate `Scheduler` business errors into structured MCP tool result codes.
 *
 * 与 IPC 层 `apps/desktop/src/main/maker-ipc/schedule.ts:73-78` 的
 * `rewrapSchedulerError` 嗅探规则**保持一致**（cron / timezone / not found 三类
 * message → 三个 IPC 错误码），多了一个 `SCHEDULER_NOT_READY` 用于 reset 期间
 * `getScheduler()` 抛 'scheduler not started' 的场景。
 *
 * MCP tool result 错误码必须复用 IPC 层错误码；utility-model 耗尽也沿用 desktop
 * generator 的稳定 code，避免 UI 与 MCP 对同一失败给出不同分类。
 */
export type SchedulerToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL'
  | 'SCHEDULER_NOT_READY'
  | 'UTILITY_MODEL_NO_CANDIDATE'
  | 'UTILITY_MODEL_ALL_CANDIDATES_FAILED'
  | 'UTILITY_MODEL_EMPTY_RESPONSE'
  | 'UTILITY_MODEL_TIMEOUT';

export interface SchedulerToolError {
  code: SchedulerToolErrorCode;
  message: string;
}

/**
 * Map an unknown error thrown by `Scheduler` (or `getScheduler()`) to a
 * structured `{code, message}` payload. Pure — no throw, no logging.
 */
export function classifySchedulerError(err: unknown): SchedulerToolError {
  const message = err instanceof Error ? err.message : String(err);
  const utilityCode = /^\[(UTILITY_MODEL_(?:NO_CANDIDATE|ALL_CANDIDATES_FAILED|EMPTY_RESPONSE|TIMEOUT))\]/
    .exec(message)?.[1];
  if (utilityCode) {
    // Append actionable hint so the MCP caller (agent) can suggest a workaround
    // instead of silently retrying the same failing utility-model chain.
    // See #3317.
    const hints: Record<string, string> = {
      UTILITY_MODEL_ALL_CANDIDATES_FAILED:
        ' All utility-model candidates failed. You can bypass generation by passing the "script" parameter directly with a hand-written check script.',
      UTILITY_MODEL_NO_CANDIDATE:
        ' No utility-model candidate is configured. You can bypass generation by passing the "script" parameter directly.',
      UTILITY_MODEL_TIMEOUT:
        ' The utility-model call timed out. You can bypass generation by passing the "script" parameter directly.',
      UTILITY_MODEL_EMPTY_RESPONSE:
        ' The utility-model returned an empty response. You can bypass generation by passing the "script" parameter directly.',
    };
    const hint = hints[utilityCode] ?? '';
    return { code: utilityCode as SchedulerToolErrorCode, message: message + hint };
  }
  if (/scheduler not started/i.test(message)) {
    return { code: 'SCHEDULER_NOT_READY', message };
  }
  if (/not found/i.test(message)) {
    return { code: 'NOT_FOUND', message };
  }
  // 'script execution ...' 是引擎 validateScheduleExecutionShape 对 script 模式
  // 形状校验的固定前缀(engine/scheduler.ts),属参数错误而非内部错误。
  if (/invalid|cron|timezone|script execution/i.test(message)) {
    return { code: 'INVALID_PARAMS', message };
  }
  return { code: 'INTERNAL', message };
}
