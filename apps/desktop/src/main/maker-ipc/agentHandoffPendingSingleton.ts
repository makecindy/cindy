/**
 * pending 上下文交接注册表的进程级单例。
 *
 * 为什么要单例:交接注入必须覆盖**所有**把消息送进 agent 的入口——renderer 发送
 * 事务(makerSendTransaction)之外,scheduler runner / IM(飞书)turnRunner /
 * goal 循环都是拿 live session 直接 `session.send` 的直发路径(2026-07-20 审计
 * 实锤),它们各自的 deps 注入链互不相通,靠 register.ts 闭包实例无法触达。
 *
 * 独立成小模块(而不是放 agentHandoff.ts):保持 agentHandoff 零依赖纯函数可测,
 * 本模块承担与 localDb 的接线(静态 import,遵守 main 禁运行时动态 import)。
 *
 * 直发路径的用法(见 scheduler-host/runner.ts、im/shared/turnRunner.ts、
 * goal-host/controller.ts 的调用点):
 *   const handoff = await agentHandoffPending.peek(sessionId);
 *   const outgoing = handoff ? prependHandoffToUserMessage(message, handoff) : message;
 *   const result = await session.send(outgoing, ...);
 *   if (handoff && result.accepted) agentHandoffPending.consume(sessionId);
 */

import { markLatestAgentHandoffConsumed } from '../localDb/ipc/messages.js';
import { createLogger } from '../logger.js';
import { createAgentHandoffPending } from './agentHandoffPending.js';

const log = createLogger('agent-handoff-pending');

/** The registry and its database reads: agentHandoffPending.ts. */
export const agentHandoffPending = createAgentHandoffPending({
  // Read at consumption, not at load, as before the registry moved.
  markLatestAgentHandoffConsumed: (sessionId) => markLatestAgentHandoffConsumed(sessionId),
  log,
});
