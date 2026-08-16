/**
 * 同一任务里因上下文超限而隐藏重建原生 Agent 会话。
 *
 * 抄 messageDeleteHandler 的 same-engine context_rebuild，不抄可见 agent_switch。
 * 规划函数是纯的，host 只负责关 live handle、落库、注入交接、wire 重放失败那条 user 消息。
 */

import {
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
} from '@cindy/maker-core';

import {
  buildHandoffText,
  extractPlainText,
  type HandoffSourceMessage,
} from './agentHandoff.js';

const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

export interface OverflowSourceMessage extends HandoffSourceMessage {
  clientId: string;
}

export type OverflowRolloverStopReason = 'no-user' | 'has-side-effects' | 'already-rolled';

export type OverflowRolloverPlan =
  | {
      action: 'rebuild';
      sourceUserClientId: string;
      sourceUserContent: unknown;
      handoffMessages: OverflowSourceMessage[];
    }
  | { action: 'stop'; reason: OverflowRolloverStopReason };

export function isContextOverflowErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { reason?: unknown; message?: unknown; sdkError?: unknown };
  if (rec.reason === CONTEXT_OVERFLOW_REASON) return true;
  return [rec.message, rec.sdkError].some(
    (value) => typeof value === 'string' && isContextOverflowErrorMessage(value),
  );
}

function isSyntheticUser(message: OverflowSourceMessage): boolean {
  if (message.role !== 'user') return false;
  return extractPlainText(message.content).startsWith(SYNTHETIC_TRIGGER_PREFIX);
}

function hasTurnSideEffects(messagesAfterUser: OverflowSourceMessage[]): boolean {
  for (const message of messagesAfterUser) {
    if (message.role === 'tool_use' || message.role === 'tool_result') return true;
    if (message.role === 'assistant' && extractPlainText(message.content).trim().length > 0) {
      return true;
    }
  }
  return false;
}

export function planContextOverflowRollover(
  messages: OverflowSourceMessage[],
  alreadyRolledUserClientId?: string | null,
): OverflowRolloverPlan {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user' && !isSyntheticUser(message)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return { action: 'stop', reason: 'no-user' };
  const sourceUser = messages[lastUserIndex]!;
  if (alreadyRolledUserClientId && alreadyRolledUserClientId === sourceUser.clientId) {
    return { action: 'stop', reason: 'already-rolled' };
  }
  if (hasTurnSideEffects(messages.slice(lastUserIndex + 1))) {
    return { action: 'stop', reason: 'has-side-effects' };
  }
  return {
    action: 'rebuild',
    sourceUserClientId: sourceUser.clientId,
    sourceUserContent: sourceUser.content,
    handoffMessages: messages.slice(0, lastUserIndex),
  };
}

export function engineLabelForOverflow(agentKind: string): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude Code';
}

export interface ContextOverflowRolloverDeps {
  getSessionRow(sessionId: string): Promise<{
    status: string;
    agentKind: string;
    remoteHostId: string | null;
  } | null>;
  listMessages(sessionId: string): Promise<OverflowSourceMessage[]>;
  findLatestRebuildMeta(
    sessionId: string,
  ): Promise<{ reason?: string; sourceUserClientId?: string | null } | null>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  closeSession(sessionId: string): Promise<void>;
  drainPersistQueue(): Promise<void>;
  commitRebuild(
    sessionId: string,
    handoff: string,
    meta: { reason: 'context-overflow'; sourceUserClientId: string | null },
  ): Promise<void>;
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  readPendingHandoffGeneration?(sessionId: string): number;
  replayUserMessage(sessionId: string, content: unknown): Promise<void>;
  onRebuilt?(sessionId: string): void;
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createContextOverflowRollover(deps: ContextOverflowRolloverDeps): {
  claim(sessionId: string): boolean;
  tryRecover(sessionId: string, errorData: unknown): Promise<boolean>;
} {
  const inFlight = new Set<string>();

  return {
    claim(sessionId: string): boolean {
      if (inFlight.has(sessionId)) return false;
      inFlight.add(sessionId);
      return true;
    },

    async tryRecover(sessionId: string, errorData: unknown): Promise<boolean> {
      try {
        if (!isContextOverflowErrorData(errorData)) return false;
        await deps.drainPersistQueue();
        const sessionRow = await deps.getSessionRow(sessionId);
        if (!sessionRow || sessionRow.status === 'deleted') return false;
        if (sessionRow.remoteHostId) return false;

        return await deps.withCloseSuppressed(sessionId, async () => {
          const live = deps.getLiveSession(sessionId);
          if (live?.isTurnRunning()) {
            deps.log.warn('context overflow rollover skipped: turn still running', { sessionId });
            return false;
          }
          const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
          const [source, rebuildMeta] = await Promise.all([
            deps.listMessages(sessionId),
            deps.findLatestRebuildMeta(sessionId),
          ]);
          const alreadyRolled =
            rebuildMeta?.reason === 'context-overflow' ? rebuildMeta.sourceUserClientId : null;
          const plan = planContextOverflowRollover(source, alreadyRolled);
          if (plan.action === 'stop') {
            deps.log.info('context overflow rollover stopped', {
              sessionId,
              reason: plan.reason,
            });
            return false;
          }

          if (live) await deps.closeSession(sessionId);
          const label = engineLabelForOverflow(sessionRow.agentKind);
          const handoff = buildHandoffText(plan.handoffMessages, {
            fromLabel: label,
            toLabel: label,
            sessionId,
            reason: 'context-overflow',
          });
          await deps.commitRebuild(sessionId, handoff, {
            reason: 'context-overflow',
            sourceUserClientId: plan.sourceUserClientId,
          });
          deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
          deps.onRebuilt?.(sessionId);
          await deps.replayUserMessage(sessionId, plan.sourceUserContent);
          deps.log.info('context overflow rollover replayed user message', {
            sessionId,
            sourceUserClientId: plan.sourceUserClientId,
          });
          return true;
        });
      } catch (error) {
        deps.log.warn('context overflow rollover failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        inFlight.delete(sessionId);
      }
    },
  };
}
