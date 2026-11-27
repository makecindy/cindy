/**
 * scheduler/deleteRun.ts — schedule_delete_run tool
 *
 * 只删一条运行记录。整条自动化仍用 schedule_delete。
 * 本机走 Scheduler.deleteRun，也就是 maker:schedule:delete-run 的同一入口。
 */

import { z } from 'zod';

import { runOnDevice, writeDeviceShape } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleDeleteRunTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_delete_run',
    category: 'scheduler',
    description:
      '删除一条定时任务的单次运行记录，不删除整条自动化，也不改它的下次运行时间。runId 来自 schedule_list_runs，不是定时任务 id。默认删本机；记录在其它电脑上时传 device。找不到或已经删除时返回 NOT_FOUND。',
    inputShape: {
      runId: z.string().min(1).describe('要删除的运行记录 id'),
      ...writeDeviceShape,
    },
    handler: async ({ runId, device }) =>
      runOnDevice(
        deps,
        device,
        async (scheduler) => {
          await scheduler.deleteRun(runId);
          return { deleted: runId };
        },
        { op: 'delete-run', args: [runId], map: () => ({ deleted: runId }) },
      ),
  });
}
