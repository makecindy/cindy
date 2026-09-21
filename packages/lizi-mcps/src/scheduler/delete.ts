/**
 * scheduler/delete.ts — schedule_delete tool
 *
 * 不加二次确认参数：已有删除授权或达到自身自动跟进的既定清理条件时直接执行；
 * 其他不可撤销的删除仍需先确认目标与授权。
 *
 * caller-ownership 豁免：agent 在任务 run 内删除**自己的** schedule（心跳任务
 * merge 后收口的标准动作）时，engine 的 delete 会先 abort 该 schedule 名下所有
 * in-flight run —— 包括发起删除的这轮 run 自己，等于自杀：turn 被强杀、收尾汇报
 * 被掐断、delete 工具调用本身被 SDK 以 rejection 收场（尽管删除已成功）。这里从
 * MCP 会话上下文解析调用方 session 当前 in-flight 的 runId，传给 engine 豁免，
 * 让发起方 run 自然跑完。解析不到（非任务内调用，如用户聊天里手动删）时不传，
 * 行为与原来完全一致（全部 abort）。
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleDeleteTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_delete',
    category: 'scheduler',
    description:
      '永久删除一条 schedule（同时级联删 schedule_runs 表里它的所有历史 run），不可撤销。先核对目标与授权；本次自动跟进达到既定停止和清理条件时，可清理自身调度，无需重复确认。其他未获授权的删除须先确认，不得扩展到其他调度。在自动化任务 run 内删除自己所属的 schedule 时，本轮 run 会被豁免、自然跑完，不会被删除动作中断。',
    inputShape: {
      id: z.string().min(1).describe('要删除的 schedule id'),
    },
    handler: async ({ id }) =>
      withScheduler(deps, async (scheduler) => {
        // 与 silenceCurrentRun 同源的 caller-ownership 解析:按调用方 session 反查
        // in-flight runId。它可能属于别的 schedule(agent 在 A 的 run 里删 B)——
        // 那种情况 runId 不在被删 schedule 的 inflight set 里,豁免天然不命中。
        const sessionId = getSessionContext?.().sessionId;
        const exemptRunId = sessionId
          ? scheduler.resolveInflightRunForSession(sessionId)
          : undefined;
        await scheduler.delete(id, exemptRunId ? { exemptRunId } : undefined);
        return { deleted: id };
      }),
  });
}
