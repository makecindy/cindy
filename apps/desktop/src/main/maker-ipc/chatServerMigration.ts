/** Restartable upgrade of account-local history into the one server timeline. */
import { randomUUID } from 'node:crypto';
import type { BotGroupAttachment, BotGroupMessageView, BotGroupSummary, BotGroupPlanView } from '../../shared/botGroupChat.js';

export type ChatApi = <T>(route: string, method?: string, data?: unknown, actorId?: string) => Promise<T>;
export interface ChatContentBlock { type: string; text?: string; mediaId?: string; caption?: string; namespace?: string; schemaRevision?: number; fallback?: string; data?: Record<string, unknown> }
export interface LocalChatUpgrade {
  api: ChatApi;
  selfId: string;
  current: () => boolean;
  groups: () => Promise<BotGroupSummary[]>;
  messages: (groupId: string, after: number) => Promise<BotGroupMessageView[]>;
  plan?: (groupId: string, planId: string) => Promise<BotGroupPlanView | null>;
  bot: (id: string, name: string) => Promise<string>;
  attachments: (roomId: string, source: string, files: BotGroupAttachment[], actorId: string) => Promise<ChatContentBlock[]>;
  afterMessages?: (sourceId: string, roomId: string) => Promise<void>;
  onRoom?: (sourceId: string, roomId: string) => void;
  onError?: (sourceId: string, error: unknown) => void;
  receipts?: {
    read: (groupId: string) => { roomId: string; sequence: number; version?: 2 } | null;
    save: (groupId: string, receipt: { roomId: string; sequence: number; version?: 2 }) => void;
  };
}

export async function migrateLocalGroups(deps: LocalChatUpgrade): Promise<Map<string, string>> {
  const migrated = new Map<string, string>();
  const check = () => { if (!deps.current()) throw new Error('OWNER_CHANGED'); };
  for (const group of await deps.groups()) {
    try {
      check();
      const receipt = deps.receipts?.read(group.id);
      if (receipt && !(await deps.messages(group.id, receipt.sequence)).length) {
        check();
        // Already upgraded: no management request on a group since left/transferred.
        migrated.set(group.id, receipt.roomId);
        deps.onRoom?.(group.id, receipt.roomId);
        if (receipt.version !== 2) {
          await deps.afterMessages?.(group.id, receipt.roomId);
          deps.receipts?.save(group.id, { ...receipt, version: 2 });
        }
        continue;
      }
      const participants = await Promise.all(group.members.map(m => deps.bot(m.botId, m.name)));
      const room = await deps.api<{ id: string }>('/conversations', 'POST', {
        operationId: randomUUID(), sourceId: group.id, kind: 'group', name: group.name,
        participants, responseMode: group.replyMode, speakingMode: group.speakingMode, history: 'shared',
      });
      check();
      migrated.set(group.id, room.id);
      deps.onRoom?.(group.id, room.id);
      const prefix = `desktop:${group.id}:`;
      const progress = await deps.api<{ sourceId: string | null }>(`/conversations/${room.id}/import?sourceId=${group.id}`);
      const cursor = progress.sourceId?.startsWith(prefix) ? progress.sourceId.slice(prefix.length) : '';
      const parsed = cursor ? /^(\d{20})(?::\d{6}(:done)?)?$/.exec(cursor) : null;
      if (cursor && !parsed) throw new Error('INVALID_IMPORT_CURSOR');
      // A large local reply can span several server messages. Only the final part
      // advances the local watermark; a partial batch resumes the same source row.
      let after = parsed ? Number(parsed[1]) - (cursor.includes(':') && !parsed[2] ? 1 : 0) : 0;
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('INVALID_IMPORT_CURSOR');
      const members = new Set(participants);
      for (;;) {
        check();
        const page = await deps.messages(group.id, after);
        if (!page.length) break;
        let batch: Record<string, unknown>[] = [];
        let bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          check();
          await deps.api(`/conversations/${room.id}/import`, 'POST', { operationId: randomUUID(), messages: batch });
          batch = []; bytes = 0;
        };
        for (const message of page) {
          check();
          const authorId = message.authorKind === 'bot' && message.authorBotId
            ? await deps.bot(message.authorBotId, message.authorName) : deps.selfId;
          if (authorId !== deps.selfId && !members.has(authorId)) {
            // Deleted/archived authors still own their history. They are not executors.
            await deps.api(`/conversations/${room.id}/members`, 'POST', { operationId: randomUUID(), actorId: authorId, action: 'invite' });
            members.add(authorId);
          }
          const sourceId = `${prefix}${String(message.sequence).padStart(20, '0')}`;
          const media = await deps.attachments(room.id, sourceId, message.attachments, authorId);
          const originalPlan = message.planId ? await deps.plan?.(group.id, message.planId) : null;
          // Preserve the arrangement and hand-off record in the server history;
          // machine-specific workspace paths are never a portable file reference.
          const plan = originalPlan ? { ...originalPlan, workDir: null } : null;
          const activity = message.kind === 'plan' && plan
            ? plan.steps.map(step => `${step.position + 1}. ${step.botName}: ${step.task} [${step.status}]`).join('\n')
            : '';
          const fallback = [activity, message.files.length ? message.files.join('\n') : ''].filter(Boolean).join('\n');
          const texts: string[] = [];
          if (message.content.length <= 32000 && Buffer.byteLength(message.content) < 48000) texts.push(message.content);
          else {
            const points = Array.from(message.content);
            for (let i = 0; i < points.length; i += 6000) texts.push(points.slice(i, i + 6000).join(''));
          }
          for (const [part, text] of texts.entries()) {
            const last = part === texts.length - 1;
            const content: ChatContentBlock[] = text ? [{ type: 'text', text }] : [];
            if (last) content.push(...media);
            // Preserve notice/plan kinds and author snapshots without uploading private host paths.
            content.push({ type: 'card', namespace: 'cindy.local-history', schemaRevision: 1,
              fallback: last && fallback ? fallback : message.kind === 'message' ? '历史消息' : message.content.slice(0, 1000) || '群活动',
              data: { kind: message.kind, authorKind: message.authorKind, authorName: message.authorName,
                noticeCode: message.noticeCode, files: message.files, planId: message.planId,
                ...(last && plan ? { plan } : {}), ...(last && fallback ? { activity: true } : {}) } });
            // Refuse rather than truncate a record outside the server's wire budget.
            if (content.length > 32 || Buffer.byteLength(JSON.stringify(content)) > 65536) throw new Error('IMPORT_MESSAGE_TOO_LARGE');
            const row = { sourceId: texts.length === 1 ? sourceId : `${sourceId}:${String(part).padStart(6, '0')}${last ? ':done' : ''}`,
              authorId, createdAt: new Date(message.createdAt).toISOString(), content, mentions: [] };
            const size = Buffer.byteLength(JSON.stringify(row));
            if (bytes + size > 200000 || batch.length >= 50) await flush();
            batch.push(row); bytes += size;
          }
          after = message.sequence;
        }
        await flush();
      }
      check();
      await deps.afterMessages?.(group.id, room.id);
      deps.receipts?.save(group.id, { roomId: room.id, sequence: after, version: 2 });
      migrated.set(group.id, room.id);
    } catch (error) {
      check();
      if (!deps.onError) throw error;
      deps.onError(group.id, error);
    }
  }
  return migrated;
}
