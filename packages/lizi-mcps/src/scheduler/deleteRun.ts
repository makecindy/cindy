/**
 * scheduler/deleteRun.ts — schedule_delete_run tool
 *
 * 只删一条运行记录。整条自动化仍用 schedule_delete。
 * 本机走 Scheduler.deleteRun，也就是 maker:schedule:delete-run 的同一入口。
 */

import { summarizeRun } from '@cindy/maker-shared';
import type { Scheduler } from '@cindy/maker-scheduler';
import { z } from 'zod';

import { runOnDevice, writeDeviceShape } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

/** 与界面删除按钮同一判断：running 和 legacy session run 不能删。 */
export async function deleteScheduleRunIfAllowed(scheduler: Scheduler, runId: string): Promise<{ deleted: string }> {
  const run = await scheduler.getRun(runId);
  if (!run) throw new Error(`Schedule run not found: ${runId}`);
  if (!summarizeRun(run).canDelete) {
    throw new Error('invalid schedule run delete: running and legacy session runs cannot be deleted');
  }
  await scheduler.deleteRun(runId);
  return { deleted: runId };
}

export function registerScheduleDeleteRunTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_delete_run',
    category: 'scheduler',
    description:
      '只删单条运行记录，不删自动化，也不改下次运行时间。runId 来自 schedule_list_runs，不是定时任务 id。能否删除与界面相同（summarizeRun 的 canDelete）：正在运行的记录和旧版会话记录不能删。默认本机；记录在其它电脑上时传 device。第二次删除或不存在时返回 NOT_FOUND，不会当成已经成功。',
    inputShape: {
      runId: z.string().min(1).describe('要删除的运行记录 id'),
      ...writeDeviceShape,
    },
    handler: async ({ runId, device }) =>
      runOnDevice(
        deps,
        device,
        (scheduler) => deleteScheduleRunIfAllowed(scheduler, runId),
        { op: 'delete-run', args: [runId], map: () => ({ deleted: runId }) },
      ),
  });
}
