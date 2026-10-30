/**
 * scheduler/list.ts — schedule_list tool
 *
 * 本机结果透传 Scheduler.list(filter?) 返回值，与 maker.schedule.list() IPC 同形（plan
 * §C.6 硬规则：禁止 snake/camel 二次转换或裁字段，MCP / GUI 必须看到同一份数据）。
 * 其它电脑的结果来自对方的同一 IPC，按电脑分组。
 */

import { z } from 'zod';

import { SCHEDULE_STATUS } from './_enums.js';
import { readDeviceShape, readOnDevices } from './_devices.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

/** Case-insensitive substring match over the fields a user would recognize a schedule by. */
export function filterSchedulesByText(rows: unknown, query: string | undefined): unknown {
  const needle = query?.trim().toLowerCase();
  if (!needle || !Array.isArray(rows)) return rows;
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const schedule = row as Record<string, unknown>;
    return [
      schedule.id,
      schedule.name,
      schedule.prompt,
      schedule.targetSessionId,
      schedule.workingDir,
      (schedule.preRunHook as { command?: unknown } | undefined)?.command,
      (schedule.scriptConfig as { command?: unknown } | undefined)?.command,
    ].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
  });
}

export function registerScheduleListTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  registry.register({
    name: 'schedule_list',
    category: 'scheduler',
    description:
      '列出定时任务。默认只列本机的（与本机 GUI 列表同源同形）；定时任务保存在各自的电脑上，要确认「有没有 / 是否在跑」须传 device="all" 把其它电脑一并查到，结果按电脑分组，没查到的电脑会写明原因（partial=true 时不能断言不存在）。可按 status（active / paused / expired）和 query（按名称、提示词、绑定任务 id、工作目录、检查脚本命令做文本匹配，如 PR 链接）筛选。返回 Schedule[] 完整字段（含 cron 表达式 / nextFireAt / lastFiredAt / notify 嵌套对象等）。',
    inputShape: {
      status: z
        .enum(SCHEDULE_STATUS)
        .optional()
        .describe('过滤指定状态；不传 = 不按状态过滤'),
      query: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('文本筛选（不区分大小写的子串匹配），如 PR 链接、任务 id 或名称片段。'),
      ...readDeviceShape,
    },
    handler: async ({ status, query, device }) =>
      readOnDevices(
        deps,
        device,
        (scheduler) => scheduler.list(status ? { status } : undefined),
        {
          op: 'list',
          args: [status ? { status } : undefined],
          map: (rows) => filterSchedulesByText(rows, query),
        },
        // 本机结果自带范围,避免把「本机没有」读成「哪台电脑都没有」。
        deps.remote ? { note: '仅本机；其它电脑用 device="all"。' } : {},
      ),
  });
}
