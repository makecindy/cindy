/**
 * scheduler/resume.ts — schedule_resume tool
 */

import { z } from 'zod';

import { runOnDevice, writeDeviceShape } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleResumeTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_resume',
    category: 'scheduler',
    description:
      '把 paused 的定时任务恢复为 active（默认本机，其它电脑上的任务传 device）：nextFireAt 按当前时间 + cronExpr 重算（不会"补"暂停期间错过的触发）。',
    inputShape: {
      id: z.string().min(1).describe('要恢复的 schedule id'),
      ...writeDeviceShape,
    },
    handler: async ({ id, device }) =>
      runOnDevice(deps, device, (scheduler) => scheduler.resume(id), { op: 'resume', args: [id] }),
  });
}
