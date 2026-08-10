/**
 * scheduler/notifyCurrentRun.ts — schedule_notify_current_run tool
 *
 * 静默运行的自动任务默认不打扰用户。任务内 agent 判断本轮有新变化、待处理项
 * 或其它值得用户看的结果时调用本工具，把当前 run 恢复为普通提醒路径。
 */

import { z } from 'zod';

import { resolveSchedulerRunIdCandidates, withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleNotifyCurrentRunTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_notify_current_run',
    category: 'scheduler',
    description:
      '静默运行任务中主动请求提醒用户:当本轮有新变化、待处理项或其它值得用户关注的结果时调用。通常无需传参数,工具会自动定位你这个会话当前正在跑的 run。只有无法识别调用会话时才需要显式传 runId。run 已结束或当前会话没有进行中的 run 时返回 NOT_FOUND。',
    inputShape: {
      runId: z
        .string()
        .min(1)
        .optional()
        .describe(
          '可选,通常不传。仅当工具无法从会话上下文识别本轮 run 时,才回退使用此显式 runId。',
        ),
    },
    handler: async ({ runId }) =>
      withScheduler(deps, async (scheduler) => {
        const { sessionId, runIds } = resolveSchedulerRunIdCandidates(
          scheduler,
          getSessionContext?.(),
          runId,
        );
        for (const targetRunId of runIds) {
          if (scheduler.notifyRun(targetRunId)) {
            return { notified: true, runId: targetRunId };
          }
        }
        if (sessionId) {
          throw new Error(
            'in-flight run not found for current session — notify can only be called while this session has an automation run executing',
          );
        }
        throw new Error(
          `in-flight run not found: ${runIds[0] ?? 'unknown'} — notify can only be called while this run is executing`,
        );
      }),
  });
}
