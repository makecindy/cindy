/**
 * 把 AgentInputCoordinator 的 renderer projection 压成 MCP 可见的只读队列快照。
 * 这里刻意不返回模型、权限、附件与持久化 payload，避免诊断接口扩大数据面。
 */

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export interface SessionQueueInspectionEntry {
  queuedMessageId: string;
  position: number;
  source: 'user' | 'orca' | 'scheduler';
  sourceLabel: string | null;
  enqueuedAtMs: number | null;
  content: string;
  consuming: boolean;
}

export function projectSessionQueueForInspection(
  pendingQueue: readonly AgentInputQueuedMessage[],
  steeringQueueClientIds: readonly string[],
): SessionQueueInspectionEntry[] {
  const consumingIds = new Set(steeringQueueClientIds);
  return pendingQueue.map((item, position) => ({
    queuedMessageId: item.clientId,
    position,
    source: queueSource(item),
    sourceLabel: queueSourceLabel(item),
    enqueuedAtMs: acceptedAtMs(item),
    content: item.origin?.kind === 'orca' ? (item.origin.displayText ?? item.text) : item.text,
    consuming: consumingIds.has(item.clientId),
  }));
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
  return null;
}

function parseCreatedAt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
