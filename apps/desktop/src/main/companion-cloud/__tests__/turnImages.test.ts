import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../localDb/schema.js';
import { readTurnImageUrls } from '../turnImages.js';

const HASH = (c: string) => `cindy-media://blobs/${c.repeat(64)}.png`;

describe('readTurnImageUrls', () => {
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  let raw: Database.Database | null = null;
  afterEach(() => {
    raw?.close();
    raw = null;
  });

  function setup() {
    raw = new Database(':memory:');
    raw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, tool_use_id TEXT, agent_meta TEXT, created_at INTEGER NOT NULL, rewind_at INTEGER);`);
    const db = raw;
    orm = drizzle(db, { schema });
    const insert = db.prepare('INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    return (id: string, role: string, content: string, at: number, meta: unknown = null) =>
      insert.run(id, `c-${id}`, 's1', role, content, meta ? JSON.stringify(meta) : null, at);
  }

  it('starts the turn at the previous row the room also gets, not at a progress note or sub-agent row', async () => {
    const add = setup();
    add('u1', 'user', JSON.stringify({ text: '画一张图' }), 100);
    add('t1', 'tool_result', JSON.stringify({ xdt_image_url: HASH('a') }), 110);
    add('a1', 'assistant', JSON.stringify({ text: '正在处理' }), 120, { assistantPhase: 'commentary' });
    add('a2', 'assistant', JSON.stringify({ text: '子任务输出' }), 125, { parentToolUseId: 'toolu_1' });
    add('a3', 'assistant', JSON.stringify({ text: '画好了' }), 130);
    add('u0', 'user', JSON.stringify({ text: '更早' }), 10);
    add('t0', 'tool_result', JSON.stringify({ xdt_image_url: HASH('z') }), 20);
    expect(await readTurnImageUrls(orm, 's1', { id: 'a3', createdAt: 130 })).toEqual([HASH('a')]);
    // A reply that is itself mirrored ends the earlier turn: its images are not taken again.
    add('a4', 'assistant', JSON.stringify({ text: '再来' }), 200);
    expect(await readTurnImageUrls(orm, 's1', { id: 'a4', createdAt: 200 })).toEqual([]);
  });
});
