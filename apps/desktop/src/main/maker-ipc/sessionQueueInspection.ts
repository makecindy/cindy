/**
 * 把 AgentInputCoordinator 的 renderer projection 压成 MCP 可见的只读队列快照。
 * 这里刻意不返回模型、权限、附件与持久化 payload，避免诊断接口扩大数据面。
 */

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export interface SessionQueueInspectionEntry {
  queuedMessageId: string;
  position: number;
  source: 'user' | 'orca' | 'scheduler' | 'session';
  sourceLabel: string | null;
  enqueuedAtMs: number | null;
  content: string;
  consuming: boolean;
}

export interface SessionQueueCountDeps {
  /** null = cold/read SQLite; undefined = live but not safely inspectable yet. */
  getLiveQueue: (sessionId: string) => SessionQueueInspectionEntry[] | null | undefined;
  loadPersistedCounts: (sessionIds: readonly string[]) => Promise<Record<string, number>>;
}

export async function resolveSessionQueueCounts(
  sessionIds: readonly string[],
  deps: SessionQueueCountDeps,
): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(sessionIds)];
  const readLiveQueue = (
    sessionId: string,
  ): SessionQueueInspectionEntry[] | null | undefined => {
    try {
      return deps.getLiveQueue(sessionId);
    } catch {
      // A single live coordinator can be between construction and queue restore,
      // or otherwise fail its process-local projection. Keep list_sessions useful
      // for every other session while reporting this one conservatively as zero.
      return undefined;
    }
  };
  const unrestoredIds = uniqueIds.filter((sessionId) => readLiveQueue(sessionId) === null);
  const persistedCounts = await deps.loadPersistedCounts(unrestoredIds);
  return Object.fromEntries(
    uniqueIds.map((sessionId) => {
      // Recheck after the async DB read: a live restore/enqueue that won the race is newer.
      const live = readLiveQueue(sessionId);
      if (live !== null) return [sessionId, live?.length ?? 0];
      return [sessionId, persistedCounts[sessionId] ?? 0];
    }),
  );
}

export function projectSessionQueueForInspection(
  pendingQueue: readonly AgentInputQueuedMessage[],
  steeringQueueClientIds: readonly string[],
  activeItem: AgentInputQueuedMessage | null = null,
  directSteeringItems: readonly AgentInputQueuedMessage[] = [],
): SessionQueueInspectionEntry[] {
  const consumingIds = new Set(steeringQueueClientIds);
  const seen = new Set<string>();
  const result: SessionQueueInspectionEntry[] = [];
  const append = (item: AgentInputQueuedMessage, consuming: boolean): void => {
    if (seen.has(item.clientId)) return;
    seen.add(item.clientId);
    result.push({
      queuedMessageId: item.clientId,
      position: result.length,
      source: queueSource(item),
      sourceLabel: queueSourceLabel(item),
      enqueuedAtMs: acceptedAtMs(item),
      content:
        item.origin?.kind === 'orca' || item.origin?.kind === 'session'
          ? (item.origin.displayText ?? item.text)
          : item.text,
      consuming,
    });
  };

  if (activeItem) append(activeItem, true);
  for (const item of directSteeringItems) append(item, true);
  for (const item of pendingQueue) append(item, consumingIds.has(item.clientId));
  return result;
}

function acceptedAtMs(item: AgentInputQueuedMessage): number | null {
  if (typeof item.hostAcceptedAtMs === 'number' && Number.isFinite(item.hostAcceptedAtMs)) {
    return item.hostAcceptedAtMs;
  }
  return parseCreatedAt(item.chatMessage.createdAt);
}

function queueSource(item: AgentInputQueuedMessage): SessionQueueInspectionEntry['source'] {
  return item.origin?.kind ?? 'user';
}

function queueSourceLabel(item: AgentInputQueuedMessage): string | null {
  if (item.origin?.kind === 'orca') return item.origin.senderLabel;
  if (item.origin?.kind === 'scheduler') return item.origin.scheduleName;
  if (item.origin?.kind === 'session') return item.origin.senderSessionId;
  return null;
}

function parseCreatedAt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
