import { encodeCursor } from '@cindy/mcps/history-cursor';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import {
  declaredGhostTaskEventTopics, ghostTaskEventApproved,
  type GhostTaskEventTopic, type GhostTaskEventData, type InstalledGhost,
} from '../../shared/ghost.js';
import type { TaskChangeEvent } from '../localDb/taskEvents.js';
import type { GhostSubscriptionGateway } from './subscriptionGateway.js';

/** Rebuilt only on roster changes. Event delivery never enumerates installed plugins. */
export class GhostTaskEventIndex {
  private owner: DataOwnerPushStamp | undefined;
  private readonly topics = new Map<GhostTaskEventTopic, InstalledGhost[]>();

  replace(ghosts: InstalledGhost[], owner?: DataOwnerPushStamp): void {
    this.topics.clear();
    this.owner = owner;
    for (const ghost of ghosts) {
      if (!ghost.enabled) continue;
      for (const topic of declaredGhostTaskEventTopics(ghost.manifest)) {
        if (!ghostTaskEventApproved(ghost, topic)) continue;
        const entries = this.topics.get(topic) ?? [];
        entries.push(ghost);
        this.topics.set(topic, entries);
      }
    }
  }

  publish(event: TaskChangeEvent, owner: DataOwnerPushStamp, gateway: () => GhostSubscriptionGateway): void {
    if (!this.owner || owner.dataOwnerId !== this.owner.dataOwnerId || owner.ownerGeneration !== this.owner.ownerGeneration) return;
    const topic = event.kind === 'message' ? 'message' : 'task-state';
    const ghosts = this.topics.get(topic);
    // No projection, JSON parsing, cursor encoding, filesystem lookup or runtime wake at zero subscribers.
    if (!ghosts?.length) return;
    let data: GhostTaskEventData;
    if (event.kind === 'message') {
      const msg = event.message;
      if (msg.role !== 'user' && msg.role !== 'assistant') return;
      data = { sessionId: event.sessionId, messageId: msg.id, role: msg.role,
        content: taskMessageContent(msg.content), createdAt: msg.createdAt,
        historyCursor: encodeCursor({ createdAt: Date.parse(msg.createdAt), id: msg.id, rowid: msg.rowid }) };
    } else {
      data = { sessionId: event.sessionId, state: event.state };
    }
    gateway().publishIndexed(ghosts, topic, event.kind === 'message' ? 'did-message-created' : 'did-task-state-changed', data);
  }
}

/** Message text plus opaque attachment positions; never hand a Host file URL/path to a plugin. */
function taskMessageContent(raw: unknown): unknown {
  let parsed = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return raw; } }
  if (Array.isArray(parsed)) return { text: parsed.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') };
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as Record<string, unknown>;
  const attachments = [...(Array.isArray(record.images) ? record.images : []), ...(Array.isArray(record.files) ? record.files : [])];
  return { ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(attachments.length ? { attachments: attachments.map((value, attachment_index) => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const name = String(item.originalName ?? item.name ?? 'attachment').split(/[\\/]/).pop();
      return { attachment_index, name, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}) };
    }) } : {}) };
}
