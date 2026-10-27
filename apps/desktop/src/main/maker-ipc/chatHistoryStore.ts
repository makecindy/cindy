import { createHash } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient.js';
import type { ChatHistoryStore } from '@cindy/maker-shared/chat-history';

/** The captured DbClient belongs to the current owner, never to whichever owner is logged in later. */
export function createSqliteChatHistoryStore(db: DbClient, endpoint: string, humanActorId: string, readerActorId: string,
  current: () => boolean): ChatHistoryStore {
  const namespace = createHash('sha256').update(JSON.stringify([endpoint.replace(/\/$/, ''), humanActorId, readerActorId])).digest('hex');
  const versions = new Map<string, number | null>();
  const generations = new Map<string, string | null>();
  const assertCurrent = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    async read(room) {
      assertCurrent();
      const result = await db.tx('chatCache.execute', { action: 'read', namespace, room });
      assertCurrent(); versions.set(room, result.version);
      generations.set(room, result.state?.generation ?? null);
      return result.state;
    },
    async write(room, state) {
      assertCurrent();
      const result = await db.tx('chatCache.execute', { action: 'write', namespace, room, state,
        version: versions.get(room) ?? null, generation: generations.get(room) ?? null });
      assertCurrent();
      if (result.conflict) { versions.delete(room); throw new Error('CHAT_CACHE_CONFLICT'); }
      versions.set(room, result.version);
      generations.set(room, state?.generation ?? null);
    },
  };
}
