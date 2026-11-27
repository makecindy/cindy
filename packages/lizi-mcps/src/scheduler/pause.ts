/**
 * scheduler/pause.ts — schedule_pause tool
 *
 * caller-ownership 豁免：与 schedule_delete 同理（见 delete.ts 头注释）——agent
 * 在任务 run 内 pause 自己所属的 schedule 时，豁免发起方这轮 run 不被 abort，
 * 让它自然跑完。pause 后 schedule / run 行都还在，run 正常落终态，无遗留问题。
 */

import { z } from 'zod';

import { runOnDevice, writeDeviceShape } from './_devices.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerSchedulePauseTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_pause',
    category: 'scheduler',
    description:
      '把定时任务置为 paused（默认本机，其它电脑上的任务传 device）：保留所有字段但 scheduler tick 会跳过它。' +
      '临时降噪/限流冷却时建议传 pauseMinutes（或 pausedUntil）让调度器到期后自动恢复，避免人工忘记恢复导致任务长期停摆；同时可附带 reason 记录暂停原因。' +
      'schedule_resume 可随时手动提前恢复（恢复时清空 pausedUntil/pauseReason 并重算 nextFireAt）。在自动化任务 run 内暂停自己所属的 schedule 是安全的：本轮 run 会被豁免、自然跑完，不会被暂停动作中断。',
    inputShape: {
      id: z.string().min(1).describe('要暂停的 schedule id'),
      pauseMinutes: z
        .number()
        .int()
        .min(1)
        .max(43_200)
        .optional()
        .describe('可选：暂停多少分钟后自动恢复（1~43200，最多 30 天），与 pausedUntil 互斥；临时限流/冷却优先传此项避免永久遗忘'),
      pausedUntil: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('可选：到期自动恢复的 Unix ms 时间戳（必须在未来），与 pauseMinutes 互斥'),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe('可选：暂停原因说明（最多 200 字），便于后续巡检与 UI 展示'),
      ...writeDeviceShape,
    },
    handler: async ({ id, pauseMinutes, pausedUntil, reason, device }) => {
      if (pauseMinutes !== undefined && pausedUntil !== undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'INVALID_PARAMS',
                message: 'invalid request: pauseMinutes 与 pausedUntil 不能同时指定',
              }),
            },
          ],
          isError: true,
        };
      }
      const resolvedPausedUntil =
        pauseMinutes !== undefined ? Date.now() + pauseMinutes * 60_000 : pausedUntil;
      const trimmedReason = typeof reason === 'string' ? reason.trim() || undefined : undefined;
      const remoteOptions =
        resolvedPausedUntil !== undefined || trimmedReason !== undefined
          ? {
              ...(resolvedPausedUntil !== undefined ? { pausedUntil: resolvedPausedUntil } : {}),
              ...(trimmedReason !== undefined ? { pauseReason: trimmedReason } : {}),
            }
          : undefined;
      return runOnDevice(deps, device, async (scheduler) => {
        const sessionId = getSessionContext?.().sessionId;
        const exemptRunId = sessionId
          ? scheduler.resolveInflightRunForSession(sessionId)
          : undefined;
        const opts =
          exemptRunId || remoteOptions
            ? {
                ...(exemptRunId ? { exemptRunId } : {}),
                ...(remoteOptions ?? {}),
              }
            : undefined;
        return scheduler.pause(id, opts);
      }, { op: 'pause', args: remoteOptions ? [id, remoteOptions] : [id] });
    },
  });
}
