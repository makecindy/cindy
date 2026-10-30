import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { parseBotGroupThreadRouteKey } from '../../shared/botGroupChat.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import type { BotGroupTaskPostInput, BotGroupTaskPostResult } from './botGroupChatService.js';
import { createTaskCompletionDelivery, type TaskCompletionOrigin, type TaskCompletionRecord } from './taskCompletionDelivery.js';

const log = createLogger('task-completion-delivery');
const recordSchema = z.object({
  sessionId: z.string(),
  origin: z.object({ botId: z.string(), sessionId: z.string(), groupId: z.string().optional(), threadRootId: z.string().optional() }),
  receipts: z.array(z.object({ id: z.string(), execution: z.object({ instanceId: z.string(), generation: z.number().int() }),
    text: z.string(), status: z.enum(['pending', 'delivered', 'failed']), errorCode: z.string().optional(), failureShown: z.boolean().optional(), postSnapshot: z.unknown().optional() })),
});

/** Owner-scoped creation provenance and delivery outbox; never stored in a project directory. */
export function createTaskCompletionDeliveryHost(post: (input: BotGroupTaskPostInput) => Promise<BotGroupTaskPostResult>) {
  const origins = new Set<string>();
  let disposed = false;
  const scope = activeOwnerScopeKey();
  const directory = path.join(ownerScopedUserDataPath(), 'task-completion-delivery');
  const isCurrent = () => !disposed && !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope;
  const assertCurrent = () => { if (!isCurrent()) throw new Error('OWNER_CHANGED'); };
  const fileFor = (id: string) => path.join(directory, createHash('sha256').update(id).digest('hex') + '.json');
  const taskExists = async (id: string) => {
    const row = await getDbClient().drizzle.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, id)).get();
    assertCurrent();
    return !!row && row.status !== 'deleted';
  };
  const pruneDeleted = async (id: string) => {
    assertCurrent();
    if (await taskExists(id)) return;
    const file = fileFor(id);
    if (!await fs.stat(file).catch(() => null)) return;
    await withCrossProcessLock(file + '.lock', { label: 'task-completion-delivery' }, async lock => {
      if (!lock.held) throw new Error('TASK_DELIVERY_BUSY');
      assertCurrent();
      await fs.rm(file, { force: true });
      origins.delete(id);
    });
  };
  const read = async (id: string): Promise<TaskCompletionRecord | null> => {
    assertCurrent();
    try {
      const record = recordSchema.parse(JSON.parse(await fs.readFile(fileFor(id), 'utf8')));
      assertCurrent();
      if (record.sessionId !== id) throw new Error('TASK_DELIVERY_ID_MISMATCH');
      origins.add(id);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const write = async (id: string, change: (record: TaskCompletionRecord | null) => TaskCompletionRecord) => {
    assertCurrent();
    await fs.mkdir(directory, { recursive: true });
    const file = fileFor(id);
    await withCrossProcessLock(file + '.lock', { label: 'task-completion-delivery' }, async lock => {
      if (!lock.held) throw new Error('TASK_DELIVERY_BUSY');
      const record = change(await read(id));
      if (!await taskExists(id)) throw new Error('TASK_UNAVAILABLE');
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, JSON.stringify({ ...record, sessionId: id }), { mode: 0o600 });
        assertCurrent();
        await fs.rename(temp, file);
        origins.add(id);
      } finally { await fs.rm(temp, { force: true }); }
    });
  };
  const delivery = createTaskCompletionDelivery({
    read,
    resolveText: async input => {
      assertCurrent();
      if (!input.messageClientId) return input.text;
      const message = await getDbClient().drizzle.select({ content: messages.content })
        .from(messages).where(and(eq(messages.sessionId, input.sessionId), eq(messages.clientId, input.messageClientId))).get();
      assertCurrent();
      return (message && visibleMessageText('assistant', message.content)) || input.text;
    },
    update: (id, change) => write(id, record => {
      if (!record) throw new Error('TASK_DELIVERY_ORIGIN_MISSING');
      change(record);
      return record;
    }),
    pending: async () => {
      assertCurrent();
      const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const ids: string[] = [];
      for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const record = recordSchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')));
          if (!await taskExists(record.sessionId)) { await pruneDeleted(record.sessionId); continue; }
          if (record.receipts.some(receipt => receipt.status === 'pending' || (receipt.status === 'failed' && !receipt.failureShown))) ids.push(record.sessionId);
        } catch { log.warn('task delivery record unreadable'); }
      }
      assertCurrent();
      return ids;
    },
    post: async (id, origin, receipt, freeze) => {
      assertCurrent();
      if (!await taskExists(id)) {
        await pruneDeleted(id);
        return { ok: false, errorCode: 'TASK_UNAVAILABLE', retryable: false };
      }
      assertCurrent();
      if (origin.groupId) return post({ groupId: origin.groupId, botId: origin.botId,
        clientId: receipt.id, text: receipt.text, threadRootId: origin.threadRootId,
        preparePost: async (prepare, destination) => {
          const saved = await freeze(async () => ({ destination, payload: await prepare() })) as {
            destination: typeof destination; payload: Awaited<ReturnType<typeof prepare>>;
          };
          if (JSON.stringify(saved.destination) !== JSON.stringify(destination)) throw new Error('TASK_DELIVERY_SCOPE_CHANGED');
          return saved.payload;
        } });
      const target = await getDbClient().drizzle.select({ id: sessions.id }).from(sessions)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(and(eq(sessions.id, origin.sessionId), eq(sessions.status, 'active'),
          eq(botSessionLinks.botId, origin.botId))).get();
      if (!target) return { ok: false, errorCode: 'ORIGIN_UNAVAILABLE', retryable: false };
      assertCurrent();
      await createMessage(origin.sessionId, { clientId: receipt.id, role: 'assistant', content: receipt.text,
        agentMeta: { assistantPhase: 'final_answer', turnCompleted: true } }, { beforePublish: async () => assertCurrent() });
      return { ok: true };
    },
    showFailure: async (id, receipt) => {
      assertCurrent();
      await createMessage(id, { clientId: `${receipt.id}:failed`, role: 'assistant',
        content: [receipt.text, t('bots.collab.deliveryFailed')].filter(Boolean).join('\n\n'), agentMeta: { assistantPhase: 'final_answer', turnCompleted: true } },
      { beforePublish: async () => assertCurrent() });
    },
    isCurrent,
    log: () => log.warn('task completion delivery deferred'),
  });
  return {
    ...delivery,
    pruneDeleted,
    dispose() { disposed = true; delivery.dispose(); },
    report(id: string, execution: { instanceId: string; generation: number }, final: boolean) {
      if (!isCurrent() || !origins.has(id)) return false;
      delivery.report(id, execution, final);
      return true;
    },
    /** Capture before creating a worktree/runtime; persist before the first input can execute. */
    async capture(callerSessionId?: string): Promise<TaskCompletionOrigin | null> {
      if (!callerSessionId) return null;
      assertCurrent();
      const link = await getDbClient().drizzle.select({ botId: botSessionLinks.botId, role: botSessionLinks.role,
        routeKey: botSessionLinks.routeKey }).from(botSessionLinks)
        .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
        .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(botProfiles.status, 'active'),
          eq(sessions.status, 'active'), isNull(botSessionLinks.archivedAt))).get();
      assertCurrent();
      if (!link || !['canonical', 'thread', 'group'].includes(link.role)) return null;
      const thread = parseBotGroupThreadRouteKey(link.routeKey);
      const groupId = link.role === 'group' ? /^group:([^:]+)/.exec(link.routeKey ?? '')?.[1] : undefined;
      if (link.role === 'group' && !groupId) throw new Error('TASK_DELIVERY_ORIGIN_INVALID');
      return { botId: link.botId, sessionId: callerSessionId, ...(groupId ? { groupId } : {}),
        ...(thread ? { threadRootId: thread.threadRootId } : {}) };
    },
    saveOrigin: (id: string, origin: TaskCompletionOrigin) => write(id, record => record ?? { origin, receipts: [] }),
    settleTerminal(input: { sessionId: string; execution: { instanceId: string; generation: number };
      successful: boolean; text: string; messageClientId?: string }) {
      return delivery.settle(input);
    },
  };
}

export type TaskCompletionDeliveryHost = ReturnType<typeof createTaskCompletionDeliveryHost>;
