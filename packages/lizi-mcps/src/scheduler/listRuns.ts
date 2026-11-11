/**
 * scheduler/listRuns.ts — schedule_list_runs tool
 */

import { z } from 'zod';

import { readDeviceShape, readOnDevices } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleListRunsTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_list_runs',
    category: 'scheduler',
    description:
      '列出某条定时任务的历史触发记录（ScheduleRun[]，按 firedAt DESC 倒序）。默认查本机；其它电脑上的任务传 device=<deviceId>。可调 limit；storage 默认 50。',
    inputShape: {
      scheduleId: z.string().min(1).describe('Schedule id'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('返回最近 N 条；省略 = storage 默认 50'),
      ...readDeviceShape,
    },
    handler: async ({ scheduleId, limit, device }) =>
      readOnDevices(deps, device, (scheduler) => scheduler.listRuns(scheduleId, limit), {
        op: 'list-runs',
        args: [scheduleId, limit],
      }),
  });
}
