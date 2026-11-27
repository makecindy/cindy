/**
 * scheduler/markRunRead.ts — schedule_mark_run_read tool
 *
 * 本机走 Scheduler.markRunRead（与 maker:schedule:mark-run-read 同一条存储规则）。
 * 其它电脑直接调用已经存在的 maker:schedule:mark-run-read。该通道成功时不说明
 * 记录是否存在，所以跨电脑回执只表示对方接受了请求。
 */

import { z } from 'zod';

import { runOnDevice, writeDeviceShape } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleMarkRunReadTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_mark_run_read',
    category: 'scheduler',
    description:
      '把一条已结束的运行记录标为已读，只影响这一条，不清同一定时任务的其它记录。runId 来自 schedule_list_runs。默认本机：不存在或已删除返回 NOT_FOUND；已经读过返回 marked:false、reason:already-read，不改原来的已读时间；还在运行或未结束则 marked:false、reason:not-terminal。其它电脑走已有的标记通道，成功只表示对方接受了请求（accepted:true），找不到、已读或未结束都按该通道原样静默跳过，不报错。',
    inputShape: {
      runId: z.string().min(1).describe('要标为已读的运行记录 id'),
      ...writeDeviceShape,
    },
    handler: async ({ runId, device }) =>
      runOnDevice(
        deps,
        device,
        (scheduler) => scheduler.markRunRead(runId),
        { op: 'mark-run-read', args: [runId], map: () => ({ accepted: true }) },
      ),
  });
}
