import { encodeCursor } from '@cindy/mcps/history-cursor';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import {
  declaredGhostTaskEventTopics, ghostTaskEventApproved,
  type GhostTaskEventTopic, type GhostTaskEventData, type InstalledGhost,
} from '../../shared/ghost.js';
import type { TaskChangeEvent } from '../localDb/taskEvents.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import type { GhostSubscriptionGateway } from './subscriptionGateway.js';

const log = createLogger('ghost-task-events');

/** Rebuilt only on roster changes. Event delivery never enumerates installed plugins. */
export class GhostTaskEventIndex {
  private owner: DataOwnerPushStamp | undefined;
  private readonly topics = new Map<GhostTaskEventTopic, InstalledGhost[]>();

  subscribedKinds(): TaskChangeEvent['kind'][] {
    return [...(this.topics.has('message') ? ['message' as const] : []),
      ...(this.topics.has('task-state') ? ['state' as const] : [])];
  }

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

  publish(event: TaskChangeEvent, owner: DataOwnerPushStamp, gateway: () => GhostSubscriptionGateway,
    pendingRecipients?: InstalledGhost[]): void {
    if (!this.owner || owner.dataOwnerId !== this.owner.dataOwnerId || owner.ownerGeneration !== this.owner.ownerGeneration) return;
    const topic = event.kind === 'message' ? 'message' : 'task-state';
    const subscribed = this.topics.get(topic);
    // No projection, JSON parsing, cursor encoding, filesystem lookup or runtime wake at zero subscribers.
    if (!subscribed?.length) return;
    // A cursor read retains its original recipients. The gateway still checks
    // their live approval; a replacement install cannot inherit pending data.
    const ghosts = pendingRecipients ?? subscribed;
    let data: GhostTaskEventData;
    if (event.kind === 'message') {
      const msg = event.message;
      if (msg.role !== 'user' && msg.role !== 'assistant') return;
      // The write path deliberately avoids reading content back after INSERT.
      // Resolve only its committed cursor position, and only for subscribed messages.
      if (msg.rowid === undefined) {
        const db = tryGetDbClient();
        if (!db) return;
        void db.queryOne<{ rowid: number }>(
          'SELECT rowid FROM messages WHERE id = ? AND session_id = ? AND rewind_at IS NULL', [msg.id, event.sessionId],
        ).then(row => {
          if (!row || !Number.isSafeInteger(row.rowid) || row.rowid < 1 || db !== tryGetDbClient()) return;
          // Re-enter the indexed owner/subscription checks after the async read.
          this.publish({ ...event, message: { ...msg, rowid: row.rowid } }, owner, gateway, ghosts);
        }).catch(() => log.warn('committed message cursor lookup failed'));
        return;
      }
      data = { sessionId: event.sessionId, messageId: msg.id, role: msg.role,
        content: taskMessageContent(msg.content), createdAt: msg.createdAt,
        historyCursor: encodeCursor({ createdAt: Date.parse(msg.createdAt), id: msg.id, rowid: msg.rowid }) };
    } else {
      data = { sessionId: event.sessionId, state: taskState(event.state) };
    }
    gateway().publishIndexed(ghosts, topic, event.kind === 'message' ? 'did-message-created' : 'did-task-state-changed', data);
  }
}

/** Select state facts from the canonical projection; content needs separate message approval. */
function taskState(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['status', 'changedAtMs']) if (key in raw) result[key] = raw[key];
  if (raw.activity === null) result.activity = null;
  else if (raw.activity && typeof raw.activity === 'object') {
    const activity = raw.activity as Record<string, unknown>;
    result.activity = Object.fromEntries([
      'sessionId', 'phase', 'currentTurnActive', 'workingPhase', 'recordStatus', 'startedAtMs',
      'lastActivityAtMs', 'attention', 'turnGeneration', 'gracefulStopState', 'source', 'interactionKind',
    ].filter(key => key in activity).map(key => [key, activity[key]]));
  }
  return result;
}

/** Keep ordinary content; project Host attachments without their file URLs/paths. */
function taskMessageContent(raw: unknown): unknown {
  let parsed = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return raw; } }
  if (Array.isArray(parsed)) {
    const blockTypes = ['text', 'image', 'image_url', 'file', 'document', 'thinking', 'redacted_thinking'];
    if (!parsed.some(item => blockTypes.includes(item?.type))) return raw;
    return { text: parsed.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') };
  }
  if (!parsed || typeof parsed !== 'object') return raw;
  const record = parsed as Record<string, unknown>;
  const attachments = [...(Array.isArray(record.images) ? record.images : []), ...(Array.isArray(record.files) ? record.files : [])];
  if (!attachments.length) return raw;
  return { ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(attachments.length ? { attachments: attachments.map((value, attachment_index) => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const name = String(item.originalName ?? item.name ?? 'attachment').split(/[\\/]/).pop();
      return { attachment_index, name, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}) };
    }) } : {}) };
}
