/**
 * 后台任务管理入口(任务卡 / 后台任务面板 / 状态栏共用):可见性判据 + 停止执行。
 *
 * 停止按会话归属路由到执行端(见 makerTransport 的 stopAgentTaskFor /
 * stopSessionBackgroundTasksFor)。停止后的任务状态仍由事件流收口;远程镜像终态事件
 * 丢失时残留的「运行中」属既有边界,由「离开五分钟清空、重开时从历史重建」兜底。
 */

import { isSharedTaskPeer } from '@cindy/device-link';

import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';

export {
  stopAgentTaskFor as stopBackgroundTask,
  stopSessionBackgroundTasksFor as stopAllBackgroundTasks,
} from './makerTransport';

/**
 * 后台任务管理入口(停止按钮 / 状态栏后台模式)的唯一可见判据:本机会话或同账号
 * 远程会话。共享任务访客看的是房主的任务,后台任务管理权保留给房主
 * (docs/product-rules/shared-task-mode.md),访客白名单也不放行停止通道 —— 不给
 * 入口,避免点了被拒却毫无反馈。
 */
export function canManageBackgroundTasks(sessionId: string): boolean {
  return !isSharedTaskPeer(getStickySessionDeviceId(sessionId) ?? '');
}
