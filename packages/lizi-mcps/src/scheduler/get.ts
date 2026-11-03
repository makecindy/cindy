/**
 * scheduler/get.ts — schedule_get tool
 */

import { z } from 'zod';

import { readDeviceShape, readOnDevices } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleGetTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_get',
    category: 'scheduler',
    description:
      '按 id 取单条定时任务的完整字段（与 GUI 详情同源）。默认查本机；id 只在它所在的电脑上有效，其它电脑上的任务传 device=<deviceId>（或 all 逐台查找）。不存在时 data=null（不算错误）。',
    inputShape: {
      id: z.string().min(1).describe('Schedule id（来自 schedule_list / schedule_create 返回）'),
      ...readDeviceShape,
    },
    handler: async ({ id, device }) =>
      readOnDevices(deps, device, (scheduler) => scheduler.get(id), { op: 'get', args: [id] }),
  });
}
