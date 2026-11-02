import type { SchedulerMcpDeps } from '../types.js';

/** 使用 Webhook 必须有 Cindy 账号；开启后收不到事件比直接报错更难发现。 */
export function assertWebhookReceiverAvailable(deps: Pick<SchedulerMcpDeps, 'webhookReceiver'>): void {
  const receiver = deps.webhookReceiver?.();
  if (receiver === 'signed-out') {
    throw new Error('invalid request: Webhook 触发需要登录 Cindy 账号');
  }
  if (receiver === 'unavailable') {
    throw new Error('invalid request: 当前环境没有可用的 Webhook 接收服务');
  }
}
