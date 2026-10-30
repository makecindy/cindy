import type Database from 'better-sqlite3';
import type { ChatHistoryState } from '@cindy/maker-shared/chat-history';

export type ChatCacheTransaction = { namespace: string; room: string } & (
  | { action: 'read' }
  | { action: 'write'; version: number | null; generation: string | null; state: ChatHistoryState | null }
);
export interface ChatCacheResult { version: number | null; state?: ChatHistoryState; conflict?: boolean }

/** Cursor/page coverage and every message change share one SQLite transaction. */
export function runChatCacheTransaction(db: Database.Database, input: ChatCacheTransaction): ChatCacheResult {
  return db.transaction(() => {
    const args = [input.namespace, input.room];
    const row = db.prepare('SELECT version,state FROM chat_cache_rooms WHERE namespace=? AND room_id=?').get(...args) as
      { version: number; state: string } | undefined;
    if (input.action === 'read') {
      if (!row) return { version: null };
      const messages = db.prepare('SELECT message_id,payload FROM chat_cache_messages WHERE namespace=? AND room_id=?').all(...args) as Array<{ message_id: string; payload: string }>;
      return { version: row.version, state: { ...JSON.parse(row.state), messages: Object.fromEntries(messages.map(m => [m.message_id, JSON.parse(m.payload)])) } };
    }
    if ((row?.version ?? null) !== input.version || (row ? JSON.parse(row.state).generation : null) !== input.generation)
      return { conflict: true, version: row?.version ?? null };
    if (!input.state) {
      db.prepare('DELETE FROM chat_cache_messages WHERE namespace=? AND room_id=?').run(...args);
      db.prepare('DELETE FROM chat_cache_rooms WHERE namespace=? AND room_id=?').run(...args);
      return { version: null };
    }
    const version = (row?.version ?? 0) + 1;
    const { messages, ...state } = input.state;
    db.prepare(`INSERT INTO chat_cache_rooms(namespace,room_id,state,version) VALUES(?,?,?,?)
      ON CONFLICT(namespace,room_id) DO UPDATE SET state=excluded.state,version=excluded.version`).run(...args, JSON.stringify(state), version);
    const previous = db.prepare('SELECT message_id,payload FROM chat_cache_messages WHERE namespace=? AND room_id=?').all(...args) as Array<{ message_id: string; payload: string }>;
    const known = new Map(previous.map(m => [m.message_id, m.payload]));
    const upsert = db.prepare(`INSERT INTO chat_cache_messages(namespace,room_id,message_id,payload) VALUES(?,?,?,?)
      ON CONFLICT(namespace,room_id,message_id) DO UPDATE SET payload=excluded.payload`);
    for (const [id, message] of Object.entries(messages)) {
      const payload = JSON.stringify(message);
      if (known.get(id) !== payload) upsert.run(...args, id, payload);
      known.delete(id);
    }
    const remove = db.prepare('DELETE FROM chat_cache_messages WHERE namespace=? AND room_id=? AND message_id=?');
    for (const id of known.keys()) remove.run(...args, id);
    return { version };
  })();
}
