/**
 * queueHoldHandler —— `maker:input:set-hold` 的宿主侧落点。
 *
 * 单独成模块的原因有两个:IPC handler 里只剩参数与边界校验,而「先恢复队列再写停点」
 * 这条顺序可以被单测直接调用(不用在测试里编译 register.ts 的源码片段)。
 */

import type { AgentInputProjection } from '../../shared/agentInputQueue.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';

type HoldCapableCoordinator = Pick<
  AgentInputCoordinator,
  'ensureQueueRestored' | 'hold' | 'releaseHold'
>;

/**
 * @param clientId 要挂起的那一条;`null` 表示清除停点。
 */
export async function applyQueueHold(
  coordinator: HoldCapableCoordinator,
  sessionId: string,
  clientId: string | null,
): Promise<AgentInputProjection> {
  // 未恢复的会话队列会在懒加载流程里被快照重建,先恢复再写状态,否则停点会被覆盖。
  await coordinator.ensureQueueRestored(sessionId);
  return clientId === null
    ? coordinator.releaseHold(sessionId)
    : coordinator.hold(sessionId, clientId);
}
