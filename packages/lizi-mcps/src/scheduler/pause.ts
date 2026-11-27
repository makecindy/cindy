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
      '把定时任务置为 paused（默认本机，其它电脑上的任务传 device）：保留所有字段但 scheduler tick 会跳过它。schedule_resume 可恢复（恢复时 nextFireAt 按当时重算）。在自动化任务 run 内暂停自己所属的 schedule 是安全的：本轮 run 会被豁免、自然跑完，不会被暂停动作中断。',
    inputShape: {
      id: z.string().min(1).describe('要暂停的 schedule id'),
      ...writeDeviceShape,
    },
    handler: async ({ id, device }) =>
      runOnDevice(deps, device, async (scheduler) => {
        const sessionId = getSessionContext?.().sessionId;
        const exemptRunId = sessionId
          ? scheduler.resolveInflightRunForSession(sessionId)
          : undefined;
        return scheduler.pause(id, exemptRunId ? { exemptRunId } : undefined);
      }, { op: 'pause', args: [id] }),
  });
}
