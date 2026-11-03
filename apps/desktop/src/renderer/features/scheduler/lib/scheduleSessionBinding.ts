/**
 * scheduleSessionBinding — "session → 绑定它的 schedules" 反向索引
 * ---------------------------------------------------------------------------
 * heartbeat 模式的 schedule 通过 targetSessionId 绑定到已有 session。本模块从
 * 本机 schedulesStore / 远程设备分片读取绑定，供任务行、置顶卡片和任务顶部共用。
 * 远程首拉、重连与 schedule 事件在 refreshRemoteSessions 里统一刷新，行不发请求。
 *
 * 性能约定(会话列表可能上百项,每项都调 hook):
 *   - Map 按输入引用做模块级 memo:schedulesStore 的 cache 引用只在 fetch 成功
 *     swap 时变化,所有 hook 实例共享一次 O(schedules) 构建,每项查询 O(1)。
 *   - 未命中返回冻结的 EMPTY 常量,保证引用稳定,不触发下游无谓重渲染。
 *   - hook 自带 ensure():schedulesStore 目前只在 SchedulerPage 挂载时加载,
 *     sidebar 场景必须自己触发;命中 cache 是 no-op,inflight 去重保证上百个
 *     实例并发也只打一次 IPC。
 *
 * 徽章消失链路:schedule create/delete/pause/resume/expired 都会让 main 广播
 * 'changed' → schedulesStore.forceRefresh → cache 引用更新 → Map 重建。
 */

import { useEffect } from 'react';
import { useRemoteSessionScheduleBindings } from '@/features/device-link/remoteProjectsStore';
import { buildBindingMap, type ScheduleBinding } from './scheduleBindingIndex';
import { schedulesStore, useSchedulesSnapshot } from './schedulesStore';

export { buildBindingMap, __resetBindingMemoForTest } from './scheduleBindingIndex';

const EMPTY: readonly ScheduleBinding[] = Object.freeze([]);

/**
 * 跳到自动化页并 focus 指定任务的路由(与侧边栏自动化分组"编辑"同款 query
 * 机制,SchedulerPage 读 ?focus= 选中条目;任务已删除时页面兜底回退首条)。
 */
export function scheduleFocusPath(scheduleId: string): string {
  return `/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}`;
}

/**
 * 返回绑定到指定 session 的 schedules(active / paused;expired 已滤)。
 * 无绑定时返回引用稳定的空数组。
 */
export function useSessionBoundSchedules(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): readonly ScheduleBinding[] {
  const snapshot = useSchedulesSnapshot();
  const remoteBindings = useRemoteSessionScheduleBindings(deviceLinkDeviceId, sessionId);
  useEffect(() => {
    // 命中 cache 是 no-op;失败静默 — schedulesStore 内部已记 lastError,
    // 徽章属增强信息,不值得在 sidebar 弹错误。
    if (!deviceLinkDeviceId) void schedulesStore.ensure().catch(() => {});
  }, [deviceLinkDeviceId]);
  // 显式按任务所属设备取值；远端无绑定/尚未加载时绝不回退到本机同 ID。
  if (deviceLinkDeviceId) return remoteBindings;
  return buildBindingMap(snapshot).get(sessionId) ?? EMPTY;
}
