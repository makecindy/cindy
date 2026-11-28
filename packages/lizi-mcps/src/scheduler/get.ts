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
      '按 id 取单条定时任务的完整字段（与 GUI 详情同源）。默认查本机；id 只在它所在的电脑上有效，其它电脑上的任务传 device=<deviceId>（或 all 逐台查找）。不存在时 data=null（不算错误）。开启了 Webhook 触发的任务另带 webhookStatus（接收地址、是否已生成密钥、最近收到事件的时间），不含密钥本身；若当前因目标会话忙碌正在连续顺延重试，另带 deferral（count / firstAt / lastReason）。',
    inputShape: {
      id: z.string().min(1).describe('Schedule id（来自 schedule_list / schedule_create 返回）'),
      ...readDeviceShape,
    },
    handler: async ({ id, device }) =>
      readOnDevices(deps, device, async (scheduler) => {
        const schedule = await scheduler.get(id);
        if (!schedule) return schedule;
        const webhookStatus = schedule.webhookTrigger ? deps.webhookStatus?.(schedule) : undefined;
        const deferred = scheduler
          .getRuntimeSnapshot?.()
          ?.deferredSchedules?.find((item) => item.scheduleId === id);
        const deferral = deferred && deferred.count > 0
          ? {
              count: deferred.count,
              firstAt: deferred.firstAt,
              ...(deferred.lastReason ? { lastReason: deferred.lastReason } : {}),
            }
          : undefined;
        if (!webhookStatus && !deferral) return schedule;
        return {
          ...schedule,
          ...(webhookStatus ? { webhookStatus } : {}),
          ...(deferral ? { deferral } : {}),
        };
      }, { op: 'get', args: [id] }),
  });
}
