/**
 * scheduler/_shared.ts
 *
 * Tiny helpers shared by every scheduler tool handler:
 *
 *  - `buildJsonResult(payload, isError?)` — wrap a JSON payload as a single-text
 *    SchedulerToolResult; identical shape to cindy_feishuBotMcpServer's
 *    `buildJsonResult` so the model sees consistent envelopes.
 *
 *  - `withScheduler(deps, fn)` — guard every tool entry with try/catch:
 *    `getScheduler()` may throw `'scheduler not started'` during reset
 *    (logout / 切账号 window per Phase 4 changelog L1459); `Scheduler.*`
 *    methods throw `'... not found'` / `'invalid cron'` etc. We translate via
 *    `classifySchedulerError` and return a structured `{ok:false, code, message}`
 *    so the model can retry or prompt the user instead of crashing the tool.
 *
 *    MCP contract: tool result error codes reuse
 *    IPC layer's NOT_FOUND / INVALID_PARAMS / INTERNAL + new SCHEDULER_NOT_READY.
 *    Implemented in errors.ts.
 */

import {
  parseCron,
  SCHEDULER_RUN_ID_VENDOR_OPTION,
  type Scheduler,
} from '@cindy/maker-scheduler';

import type { SchedulerToolResult } from '../cindy_schedulerToolRegistry.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import { classifySchedulerError } from './errors.js';

/**
 * Resolve the possible owners of a scheduler MCP call in priority order.
 *
 * A completed run can leave a stale host-owned run id while a subsequent fire
 * is already mapped to the same session. Keep the host-owned id first for the
 * auto-resume case, but let callers try the live session mapping if that id is
 * no longer active.
 */
export function resolveSchedulerRunIdCandidates(
  scheduler: Pick<Scheduler, 'resolveInflightRunForSession'>,
  sessionContext: LiziMcpSessionContext | undefined,
  explicitRunId?: string,
): { sessionId?: string; runIds: string[] } {
  const sessionId = sessionContext?.sessionId;
  const hostOwnedRunId = sessionContext?.vendorOptions?.[SCHEDULER_RUN_ID_VENDOR_OPTION];
  const mappedRunId = sessionId
    ? scheduler.resolveInflightRunForSession(sessionId)
    : undefined;
  const runIds: string[] = [];

  if (typeof hostOwnedRunId === 'string' && hostOwnedRunId.length > 0) {
    runIds.push(hostOwnedRunId);
  }
  if (typeof mappedRunId === 'string' && mappedRunId.length > 0 && !runIds.includes(mappedRunId)) {
    runIds.push(mappedRunId);
  }
  if (!sessionId && runIds.length === 0 && explicitRunId) {
    runIds.push(explicitRunId);
  }

  return { sessionId, runIds };
}

/**
 * 校验 cronExpr / timezone 在工具层就合法。
 *
 * 背景:intervalMs 模式下引擎用 `now + intervalMs` 算 nextFireAt,**不再**走
 * `nextCronOrMonthlyFire` 解析 cronExpr / timezone(见 maker-scheduler
 * engine/scheduler.ts create/update 路径)。但 cronExpr 仍作为档位 / 展示表达式
 * 落库,且日后清空 intervalMs 回退 cron 语义时会被引擎解析 —— 若此刻存进非法
 * cron / timezone,会在回退那一刻才炸,且 UI 档位展示也会坏。因此 intervalMs
 * 模式下必须在工具层显式补回这道原本由引擎承担的校验。
 *
 * parseCron 是引擎 nextRun 内部同款解析器(月底预设 `0 9 31 * *` 这类本身也是
 * 合法 5 字段 cron,不会被误杀);timezone 用 Intl.DateTimeFormat 试构造。
 * 错误消息含 "invalid" → classifySchedulerError 映射成 INVALID_PARAMS,与
 * cron-only 路径行为一致。
 */
export function assertCronAndTimezoneValid(cronExpr?: string, timezone?: string): void {
  if (cronExpr !== undefined) {
    try {
      parseCron(cronExpr);
    } catch (err) {
      throw new Error(`invalid cronExpr: ${(err as Error).message}`);
    }
  }
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw new Error(`invalid timezone: ${timezone}`);
    }
  }
}

export function buildJsonResult(payload: unknown, isError = false): SchedulerToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Run a callback with the resolved Scheduler instance, translating any thrown
 * error (including `getScheduler()` 'not started') into a structured tool
 * result. Callbacks return the success payload; we wrap it via buildJsonResult.
 */
export async function withScheduler(
  deps: SchedulerMcpDeps,
  fn: (scheduler: Scheduler) => Promise<unknown>,
): Promise<SchedulerToolResult> {
  let scheduler: Scheduler;
  try {
    scheduler = deps.getScheduler();
  } catch (err) {
    const { code, message } = classifySchedulerError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
  try {
    const data = await fn(scheduler);
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message } = classifySchedulerError(err);
    return buildJsonResult({ ok: false, code, message }, true);
  }
}
