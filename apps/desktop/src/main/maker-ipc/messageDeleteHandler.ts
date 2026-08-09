/**
 * 聊天消息删除：user 只清目标行；assistant 清除同一真实用户轮内的全部 AI 产出。
 * 本地保留无内容墓碑与其它轮次，并让下一次发送从删除后的本地历史重建原生 Agent 上下文。
 *
 * Claude/Codex 都不能在既有原生 transcript/thread 中间挖掉任意一行；因此本
 * handler 先关闭 idle live session，再由 DB 原子事务清除消息内容、清 sdkSessionId、
 * 写隐藏 handoff 标记。下一次任意发送入口复用 agentHandoffPending，把删除后的
 * 有效历史作为 wire-only 前缀注入到全新原生会话，显示/落库仍只有用户新消息。
 */

import { buildHandoffText, type HandoffSourceMessage } from './agentHandoff.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type {
  MessageDeletionTarget,
  SubagentTurnDeletionWindow,
} from '../localDb/ipc/messages.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface ContextSourceMessage extends HandoffSourceMessage {
  clientId: string;
}

interface MessageDeleteSessionRow {
  status: string;
  agentKind: string;
}

/**
 * 不含 messageCount:删除对 `_count.messages` 权威口径(全部 messages 行数)的影响只有
 * 0 或 +1(见 commitMessageDeletion 的注释),不值得为此每次删除多跑一次全表 count,故
 * 删除路径不 patch 该字段,由 sessions:list / reseed 提供权威值。见 issue #1282。
 */
interface MessageDeleteCommittedPayload {
  sessionId: string;
  deletedClientIds: string[];
  subagentRunIds: string[];
  updatedAt: number;
  preview: string | null;
}

export interface MessageDeleteHandlerDeps {
  getSessionRow(sessionId: string): Promise<MessageDeleteSessionRow | null>;
  getMessage(
    sessionId: string,
    clientId: string,
  ): Promise<MessageDeletionTarget | null>;
  listMessagesForContext(sessionId: string): Promise<ContextSourceMessage[]>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  hasBackgroundActivity(sessionId: string): boolean;
  closeSession(sessionId: string): Promise<void>;
  /** Wait for chat/Subagent observations queued before the deletion barrier. */
  drainPersistQueue(): Promise<void>;
  commitDeletion(
    sessionId: string,
    clientIds: string[],
    handoff: string,
    subagentTurnWindow?: SubagentTurnDeletionWindow,
  ): Promise<MessageDeleteCommittedPayload>;
  /** 见 sessionAgentSwitchHandler 同名字段:带代次写,防 /clear 竞态。 */
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  /** 读交接注册表的当前代次(在读历史之前取一次)。 */
  readPendingHandoffGeneration?(sessionId: string): number;
  onCommitted(
    payload: MessageDeleteCommittedPayload,
    requestedClientId: string,
  ): void | Promise<void>;
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
  };
}

function engineLabel(agentKind: string): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
}

export async function performMessageDeletion(
  deps: MessageDeleteHandlerDeps,
  params: { sessionId: unknown; clientId: unknown },
): Promise<{ sessionId: string; clientId: string; clientIds: string[] }> {
  const { sessionId, clientId } = params;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throwIpcError('INVALID_PARAMS', 'sessionId required');
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throwIpcError('INVALID_PARAMS', 'clientId required');
  }

  const [sessionRow, initialTarget] = await Promise.all([
    deps.getSessionRow(sessionId),
    deps.getMessage(sessionId, clientId),
  ]);
  if (!sessionRow || sessionRow.status === 'deleted') {
    throwIpcError('NOT_FOUND', `Session ${sessionId} not found`);
  }
  if (!initialTarget) {
    throwIpcError('NOT_FOUND', 'Message 不存在或不可删除');
  }

  const live = deps.getLiveSession(sessionId);
  if (live?.isTurnRunning()) {
    throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
  }
  if (deps.hasBackgroundActivity(sessionId)) {
    throwIpcError('SESSION_RUNNING', `Session ${sessionId} has background activity`);
  }

  return deps.withCloseSuppressed(sessionId, async () => {
    // 上面的读取和真正 close 之间仍可能有 dispatch 抢先；提交前再查一次，
    // 绝不在运行中的 turn 继续落输出时挖消息/切上下文。
    const currentLive = deps.getLiveSession(sessionId);
    if (currentLive?.isTurnRunning()) {
      throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
    }
    if (deps.hasBackgroundActivity(sessionId)) {
      throwIpcError('SESSION_RUNNING', `Session ${sessionId} has background activity`);
    }
    if (currentLive) await deps.closeSession(sessionId);
    await deps.drainPersistQueue();

    // durable FIFO 里可能仍有在删除请求前产生、但尚未落库的 tool_result / Subagent
    // 观察。屏障后必须重读目标与历史，确保它们进入同一轮的删除范围且不会混入 handoff。
    // 代次也在这份最终历史之前读取；期间若发生 /clear，registry 会拒绝旧代 handoff。
    const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
    const [target, source] = await Promise.all([
      deps.getMessage(sessionId, clientId),
      deps.listMessagesForContext(sessionId),
    ]);
    if (!target) {
      throwIpcError('NOT_FOUND', 'Message 不存在或不可删除');
    }
    const deletedClientIds = new Set(target.deletedClientIds);
    const remaining = source.filter((message) => !deletedClientIds.has(message.clientId));
    const label = engineLabel(sessionRow.agentKind);
    const handoff = buildHandoffText(remaining, {
      fromLabel: label,
      toLabel: label,
      sessionId,
      reason: 'message-deletion',
    });

    const committed = await deps.commitDeletion(
      sessionId,
      target.deletedClientIds,
      handoff,
      target.subagentTurnWindow,
    );
    deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
    await deps.onCommitted(committed, clientId);
    deps.log.info('message delete committed; native context will rebuild on next send', {
      sessionId,
      clientId,
      deletedRole: target.role,
      deletedMessages: committed.deletedClientIds.length,
      remainingMessages: remaining.length,
    });
    return {
      sessionId,
      clientId,
      clientIds: committed.deletedClientIds,
    };
  });
}

export function registerMakerMessageDeleteHandler(
  registry: IpcHandlerRegistry,
  deps: MessageDeleteHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.DELETE_MESSAGE, (_event, sessionId, clientId) =>
    performMessageDeletion(deps, { sessionId, clientId }),
  );
}
