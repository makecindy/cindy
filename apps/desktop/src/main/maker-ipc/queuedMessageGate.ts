/**
 * INPUT_ENQUEUE / INPUT_STEER 收到的排队消息形状闸门。
 *
 * wire 只能保证是 JSON,这里把 renderer / device-link 控制端传来的排队项收敛成
 * `AgentInputQueuedMessage` 的最小合法形状。`createOpts.agentKind` 与
 * `AgentInputCreateOpts` 声明的联合体同源(含 Grok Build):类型放宽了、运行时闸门
 * 还停在三个 agent 的话,composer 发送会直接被 INVALID_PARAMS 打掉。
 *
 * 只做形状校验;device-link 的会话引用可信度判定留在 register.ts 的调用点。
 */

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isAgentKind } from './agentKindGate.js';

export function requireQueuedMessageShape(value: unknown): AgentInputQueuedMessage {
  if (!value || typeof value !== 'object')
    throwIpcError('INVALID_PARAMS', 'queued message required');
  const msg = value as AgentInputQueuedMessage;
  if (typeof msg.clientId !== 'string' || !msg.clientId) {
    throwIpcError('INVALID_PARAMS', 'queued.clientId required');
  }
  if (typeof msg.text !== 'string') throwIpcError('INVALID_PARAMS', 'queued.text required');
  if (typeof msg.persistedContent !== 'string')
    throwIpcError('INVALID_PARAMS', 'queued.persistedContent required');
  if (!msg.chatMessage || typeof msg.chatMessage !== 'object') {
    throwIpcError('INVALID_PARAMS', 'queued.chatMessage required');
  }
  if (!msg.createOpts || typeof msg.createOpts !== 'object') {
    throwIpcError('INVALID_PARAMS', 'queued.createOpts required');
  }
  if (!isAgentKind(msg.createOpts.agentKind)) {
    throwIpcError('INVALID_PARAMS', 'queued.createOpts.agentKind invalid');
  }
  return msg;
}
