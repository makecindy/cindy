/**
 * scheduler/silenceCurrentRun.ts — schedule_silence_current_run tool
 *
 * 任务内 agent 确认"本轮无需用户关注"(如 PR 巡检无新动态)时调用:把**本轮这一条
 * run**标记为静默 —— 完成时跳过桌面/飞书通知,run 落库直接置 readAt(不产生未读
 * 小红点),运行历史照常保留。
 *
 * 定位本轮 run 的方式(优先级):
 *  1. **按调用方 session 自动解析(常态)**:从 MCP 会话上下文拿 sessionId,经
 *     scheduler.resolveInflightRunForSession 反查本会话当前 in-flight 的 runId。
 *     agent 无需(也不应)传 runId —— 把易漂移的 LLM 传参从根上消除,且天然只能
 *     静默自己 session 的 run(caller-ownership)。
 *  2. **回退到显式 runId**:仅当拿不到 sessionId(如未绑定 session 的 codex 调用)
 *     时,才用 agent 传入的 runId。
 *
 * 语义边界(引擎 silenceRun 的约定):
 *  - 仅对 success 终态生效;run 失败/被中止时标记被忽略,通知照发(fail-safe)
 *  - 标记只存内存,进程重启丢失 → 通知照发,安全方向正确
 *  - 解析不到 in-flight run(轮已结束/会话无进行中的 run)时返回 ok:false NOT_FOUND
 */

import { z } from 'zod';

import { resolveSchedulerRunIdCandidates, withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleSilenceCurrentRunTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_silence_current_run',
    category: 'scheduler',
    description:
      '把本轮正在执行的这一条 run 标记为静默:完成后不发桌面/飞书通知、不产生未读小红点(运行历史保留)。供自动化任务内的 agent 在确认"本轮无需用户关注"(如巡检无新动态)后调用。通常**无需传任何参数** —— 工具会自动定位你这个会话当前正在跑的 run。只有在无法识别调用会话的特殊场景才需要显式传 runId。run 已结束或当前会话没有进行中的 run 时返回 NOT_FOUND;run 失败时标记自动失效(异常仍会通知)。',
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
          if (scheduler.silenceRun(targetRunId)) {
            return { silenced: true, runId: targetRunId };
          }
        }
        if (sessionId) {
          // 消息含 "not found" → classifySchedulerError 归为 NOT_FOUND
          throw new Error(
            'in-flight run not found for current session — silence can only be called while this session has an automation run executing',
          );
        }
        throw new Error(
          `in-flight run not found: ${runIds[0] ?? 'unknown'} — silence can only be called while this run is executing`,
        );
      }),
  });
}
