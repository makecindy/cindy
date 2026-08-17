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

const PI_PROMPT_RPC_TIMEOUT_RE = /pi rpc timeout after \d+ms: prompt\b/i;

export function isPiPromptRpcTimeoutError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { message?: unknown; sdkError?: unknown };
  return [rec.message, rec.sdkError].some(
    (value) => typeof value === 'string' && PI_PROMPT_RPC_TIMEOUT_RE.test(value),
  );
}

/** PI 原生会话已经无法继续：超限，或 prompt RPC 超时（巨大 jsonl resume 卡死）。 */
export function shouldRebuildPiNativeSession(data: unknown): boolean {
  return isContextOverflowErrorData(data) || isPiPromptRpcTimeoutError(data);
}

function isSyntheticUser(message: OverflowSourceMessage): boolean {
  if (message.role !== 'user') return false;
  return extractPlainText(message.content).startsWith(SYNTHETIC_TRIGGER_PREFIX);
}

function hasTurnSideEffects(messagesAfterUser: OverflowSourceMessage[]): boolean {
  return messagesAfterUser.some((message) => message.role !== 'error');
}

export type OverflowReplayWireMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

export function persistedUserContentToWireMessage(content: unknown): OverflowReplayWireMessage {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return persistedUserContentToWireMessage(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return { type: 'user', content: content as Array<{ type: string; [k: string]: unknown }> };
  }
  if (!content || typeof content !== 'object') return '';
  const rec = content as Record<string, unknown>;
  if (rec.type === 'user') {
    if (typeof rec.content === 'string' || Array.isArray(rec.content)) {
      return rec as OverflowReplayWireMessage;
    }
  }
  const text = typeof rec.text === 'string' ? rec.text : '';
  const images = Array.isArray(rec.images) ? rec.images : [];
  const files = Array.isArray(rec.files) ? rec.files : [];
  if (images.length === 0 && files.length === 0) return text;
  const blocks: Array<{ type: string; [k: string]: unknown }> = [];
  if (text) blocks.push({ type: 'text', text });
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const item = image as Record<string, unknown>;
    const path =
      typeof item.path === 'string'
        ? item.path
        : typeof item.url === 'string'
          ? item.url
          : '';
    if (path) blocks.push({ type: 'image', path });
  }
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const item = file as Record<string, unknown>;
    const path = typeof item.path === 'string' ? item.path : '';
    if (path) blocks.push({ type: 'file', path });
  }
  return { type: 'user', content: blocks.length > 0 ? blocks : text };
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

export function errorContentToData(content: unknown): unknown {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return { message: content };
      }
    }
    return { message: content };
  }
  return content;
}

/** 最近一条终态若是超限/prompt 超时，则原生会话已死，发送前不要再 resume。 */
export function findLatestRebuildableError(messages: OverflowSourceMessage[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'error') {
      const data = errorContentToData(message.content);
      return shouldRebuildPiNativeSession(data) ? data : null;
    }
    if (message.role === 'assistant' && extractPlainText(message.content).trim().length > 0) {
      return null;
    }
  }
  return null;
}

export interface ContextOverflowRolloverDeps {
  getSessionRow(sessionId: string): Promise<{
    status: string;
    agentKind: string;
    remoteHostId: string | null;
    clearedAt: number | null;
    sdkSessionId?: string | null;
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
    meta: {
      reason: 'context-overflow' | 'pi-prompt-timeout';
      sourceUserClientId: string | null;
      expectedClearedAt?: number | null;
    },
  ): Promise<void>;
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  readPendingHandoffGeneration?(sessionId: string): number;
  replayUserMessage(
    sessionId: string,
    content: unknown,
  ): Promise<{ accepted: boolean }>;
  onRebuilt?(sessionId: string): void;
  withSessionLock?<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export type OverflowClaimResult = 'claimed' | 'in-flight' | 'idle';

export function createContextOverflowRollover(deps: ContextOverflowRolloverDeps): {
  claim(sessionId: string): OverflowClaimResult;
  tryRecover(sessionId: string, errorData: unknown): Promise<boolean>;
  prepareUnhealthySession(sessionId: string): Promise<boolean>;
} {
  const inFlight = new Set<string>();

  const runRecover = async (sessionId: string, errorData: unknown): Promise<boolean> => {
    if (!isContextOverflowErrorData(errorData)) return false;
    await deps.drainPersistQueue();
    const sessionRow = await deps.getSessionRow(sessionId);
    if (!sessionRow || sessionRow.status === 'deleted') return false;
    if (sessionRow.remoteHostId) return false;
    if (sessionRow.agentKind !== 'pi') return false;

    return deps.withCloseSuppressed(sessionId, async () => {
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
        expectedClearedAt: sessionRow.clearedAt,
      });
      deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
      deps.onRebuilt?.(sessionId);
      const replay = await deps.replayUserMessage(sessionId, plan.sourceUserContent);
      if (!replay.accepted) {
        deps.log.warn('context overflow rollover replay was not accepted', {
          sessionId,
          sourceUserClientId: plan.sourceUserClientId,
        });
        return false;
      }
      deps.log.info('context overflow rollover replayed user message', {
        sessionId,
        sourceUserClientId: plan.sourceUserClientId,
      });
      return true;
    });
  };

  const runPrepare = async (sessionId: string): Promise<boolean> => {
    const sessionRow = await deps.getSessionRow(sessionId);
    if (!sessionRow || sessionRow.status === 'deleted') return false;
    if (sessionRow.remoteHostId || sessionRow.agentKind !== 'pi') return false;
    if (!sessionRow.sdkSessionId) return false;
    const live = deps.getLiveSession(sessionId);
    if (live?.isTurnRunning()) return false;
    const source = await deps.listMessages(sessionId);
    if (!findLatestRebuildableError(source)) return false;
    let lastUser: OverflowSourceMessage | undefined;
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const message = source[i];
      if (message && message.role === 'user' && !isSyntheticUser(message)) {
        lastUser = message;
        break;
      }
    }
    if (!lastUser) return false;
    const lastError = findLatestRebuildableError(source);
    const rebuildReason = isPiPromptRpcTimeoutError(lastError)
      ? 'pi-prompt-timeout'
      : 'context-overflow';
    const handoffMessages = source.filter((message) => message.role !== 'error');
    const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
    if (live) await deps.closeSession(sessionId);
    const label = engineLabelForOverflow(sessionRow.agentKind);
    const handoff = buildHandoffText(handoffMessages, {
      fromLabel: label,
      toLabel: label,
      sessionId,
      reason: rebuildReason,
    });
    await deps.commitRebuild(sessionId, handoff, {
      reason: rebuildReason,
      sourceUserClientId: lastUser.clientId,
      expectedClearedAt: sessionRow.clearedAt,
    });
    deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
    deps.onRebuilt?.(sessionId);
    deps.log.info('unhealthy PI native session rebuilt before send; skip compact/resume', {
      sessionId,
      sourceUserClientId: lastUser.clientId,
    });
    return true;
  };

  return {
    claim(sessionId: string): OverflowClaimResult {
      if (inFlight.has(sessionId)) return 'in-flight';
      inFlight.add(sessionId);
      return 'claimed';
    },

    async tryRecover(sessionId: string, errorData: unknown): Promise<boolean> {
      try {
        if (deps.withSessionLock) {
          return await deps.withSessionLock(sessionId, () => runRecover(sessionId, errorData));
        }
        return await runRecover(sessionId, errorData);
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

    async prepareUnhealthySession(sessionId: string): Promise<boolean> {
      if (inFlight.has(sessionId)) return false;
      inFlight.add(sessionId);
      try {
        return await deps.withCloseSuppressed(sessionId, () => runPrepare(sessionId));
      } catch (error) {
        deps.log.warn('unhealthy PI session prepare failed', {
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
