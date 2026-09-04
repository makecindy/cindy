import type { Session } from '@cindy/maker-core';
import { persistSubagentTaskUpdate } from '../localDb/subagentRuns.js';
import { broadcastSubagentRunsChanged } from '../localDb/ipc/subagentRuns.js';
import {
  captureSubagentObservationGeneration,
  enqueueSubagentObservationWrite,
} from '../subagentObservationRewindFence.js';

import { createLogger } from '../logger.js';
import {
  enqueueDurableWrite,
  flushAssistantBlock,
  onAssistantTextEvent,
  onAgentTaskUpdateEvent,
  onThinkingEvent,
  onToolResultEvent,
  onToolResultFullEvent,
  onToolUseEvent,
} from '../messagePersistBroadcaster.js';
import { type OrcaTeamService } from './orcaTeamService.js';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export interface PersistSessionStreamEventDeps {
  readonly orcaTeamServiceForEvents: Pick<OrcaTeamService, 'captureWorkerText'> | null;
  readonly log: Pick<ReturnType<typeof createLogger>, 'warn'>;
}

export function persistSessionStreamEvent(
  deps: PersistSessionStreamEventDeps,
  session: Session,
  prepared: PreparedSessionEvent,
) {
  const { event, eventAgentMeta } = prepared;
  let persistId: string | undefined;
  let resolvedContent: string | undefined;
  if (event.type === 'text') {
    const td = event.data as { text?: unknown; isFinal?: unknown } | null;
    if (typeof td?.text === 'string') {
      deps.orcaTeamServiceForEvents?.captureWorkerText(session.id, td.text, {
        isFinal: td.isFinal === true,
      });
    }
    persistId = onAssistantTextEvent(
      session.id,
      event.data as {
        text?: unknown;
        isFinal?: unknown;
        isFullText?: unknown;
        agentMessageId?: unknown;
      },
      eventAgentMeta,
    );
  } else if (event.type === 'tool_use') {
    // tool_use 边界:先 flush 在飞 assistant(保证 assistant 行先于其 tool_use 入队
    // 落库),再落 tool_use 本身,拿回 persistId 盖进 payload。两者都只入队、不阻塞。
    if (event.turnScope !== 'background') flushAssistantBlock(session.id, eventAgentMeta);
    persistId = onToolUseEvent(
      session.id,
      event.data as { toolUseId?: unknown; toolName?: unknown; input?: unknown },
      eventAgentMeta,
      event.turnScope === 'background' ? 'background' : 'turn',
      event.backgroundTurnStartedAt,
      event.turnAttemptToken,
    );
  } else if (event.type === 'tool_result') {
    const r = onToolResultEvent(
      session.id,
      event.data as { summary?: unknown; toolUseIds?: unknown },
      eventAgentMeta,
      event.turnScope === 'background' ? 'background' : 'turn',
    );
    persistId = r?.persistId;
    resolvedContent = r?.content;
  } else if (event.type === 'tool_result_full') {
    const r = onToolResultFullEvent(
      session.id,
      event.data as { toolUseId?: unknown; fullText?: unknown; isError?: unknown },
      eventAgentMeta,
      event.turnScope === 'background' ? 'background' : 'turn',
    );
    persistId = r?.persistId;
    resolvedContent = r?.content;
  } else if (event.type === 'thinking') {
    // thinking final/redacted 落库收口 main;clientId=blockId(renderer 同源),无需
    // persistId 回传。start/delta 不落库。
    onThinkingEvent(
      session.id,
      event.data as {
        stage?: unknown;
        blockId?: unknown;
        text?: unknown;
        durationMs?: unknown;
      },
      eventAgentMeta,
    );
  }
  if (event.type === 'agent_task_update') {
    onAgentTaskUpdateEvent(session.id, event.data);
    // Subagent workspace is an observer only: normalize the existing
    // harness event into Cindy's durable record on the same FIFO as chat
    // messages. No launch/control path or provider payload is modified.
    const source =
      event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi'
        ? event.source
        : undefined;
    const observedAt = Date.now();
    const generationStamp = captureSubagentObservationGeneration({
      sessionId: session.id,
      data: event.data,
      source,
    });
    if (generationStamp)
      void enqueueSubagentObservationWrite({
        sessionId: session.id,
        stamp: generationStamp,
        enqueue: () =>
          enqueueDurableWrite(`subagent_update:${session.id}`, async (ownerScope) => {
            const persisted = await persistSubagentTaskUpdate(
              session.id,
              event.data,
              source,
              observedAt,
            );
            if (persisted) {
              broadcastSubagentRunsChanged({ sessionId: session.id, ...persisted }, ownerScope);
            }
            return persisted;
          }),
      }).catch((error) => {
        deps.log.warn('Subagent workspace persistence failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return { persistId, resolvedContent };
}

export type SessionStreamResult = ReturnType<typeof persistSessionStreamEvent>;
