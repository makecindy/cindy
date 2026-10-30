import type { WheelEvent } from 'react';

/**
 * 浮层滚轮放行
 * ---------------------------------------------------------------------------
 * Radix 模态 Dialog 用 react-remove-scroll 锁背景滚动:它在 document 冒泡段
 * 挂 wheel / touchmove 监听,把落在对话框内容(shard)之外的事件一律
 * preventDefault。portal 到 body 的浮层(Radix Popover、统一模型面板及其
 * 配置浮层)因此整体滚轮失效——带滚动条的列表只剩拖动滑条一条路,
 * scrollbar-hide 的窄栏则完全滚不动(2026-10-22 实测:添加伙伴对话框里
 * 服务商一多,左侧 rail 溢出的部分任何方式都滚不到)。
 *
 * 事件在到达 document 之前先经过浮层自身;在这里 stopPropagation,
 * react-remove-scroll 的 document 监听收不到事件,自然不会拦默认行为,
 * 浏览器原生滚动(含触控板惯性)照常发生。对话框之外没有滚动锁时,
 * 这只是一个无害的 no-op。同款手法早已用在 ScheduleChips 的 stopWheel。
 */
export function stopWheelPropagation(event: WheelEvent<HTMLElement>): void {
  event.stopPropagation();
}
