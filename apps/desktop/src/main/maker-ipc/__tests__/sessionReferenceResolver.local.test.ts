import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../localDb/schema.js';

const state = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db }) }));
const remoteInvoke = vi.hoisted(() => vi.fn());
vi.mock('../../device-link/index.js', () => ({
  remoteInvoke,
  getSelfDeviceId: () => 'self-device',
}));

import { resolveSessionReferences } from '../sessionReferenceResolver.js';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cleared_at INTEGER,
      remote_host_id TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  state.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

function insertMessage(
  sqlite: Database.Database,
  input: { id: string; role: string; content: string; createdAt: number; rewindAt?: number | null },
): void {
  sqlite.prepare(`
    INSERT INTO messages (
      id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at
    ) VALUES (
      @id, @id, 'local-session', @role, @content, NULL, NULL, 'cc', @createdAt, @rewindAt
    )
  `).run({
    ...input,
    content: JSON.stringify(input.content),
    rewindAt: input.rewindAt ?? null,
  });
}

describe('sessionReferenceResolver local visibility', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createDb();
    sqlite.prepare(
      `INSERT INTO sessions (id, title, cleared_at, remote_host_id) VALUES ('local-session', 'Local', 100, NULL)`,
    ).run();
  });

  it('filters /clear, rewind and non-conversation roles before applying the limit', async () => {
    insertMessage(sqlite, { id: 'old', role: 'user', content: 'before clear', createdAt: 99 });
    insertMessage(sqlite, { id: 'rewound', role: 'assistant', content: 'rewound', createdAt: 101, rewindAt: 999 });
    insertMessage(sqlite, { id: 'tool', role: 'tool_use', content: 'tool body', createdAt: 102 });
    insertMessage(sqlite, { id: 'visible-user', role: 'user', content: 'visible question', createdAt: 103 });
    insertMessage(sqlite, { id: 'visible-assistant', role: 'assistant', content: 'visible answer', createdAt: 104 });

    const [context] = await resolveSessionReferences([{ sessionId: 'local-session' }]);
    expect(context.messages.map((message) => message.content)).toEqual([
      'visible question',
      'visible answer',
    ]);
    expect(context.messageCount).toBe(2);
    expect(context.truncated).toBe(false);
  });

  it('allows SSH session history already mirrored in the controller SQLite', async () => {
    sqlite.prepare(`UPDATE sessions SET remote_host_id = 'ssh-prod' WHERE id = 'local-session'`).run();
    insertMessage(sqlite, { id: 'ssh-message', role: 'user', content: 'ssh history', createdAt: 101 });
    const [context] = await resolveSessionReferences([{ sessionId: 'local-session' }]);
    expect(context.messages).toEqual([{ role: 'user', content: 'ssh history', createdAt: 101 }]);
  });

  // 深链是可复制的字符串:控制端生成的 `?device=` 链接被带回归属设备本机
  // 粘贴发送时,ref.deviceId 指向本机自己——必须按本地会话解析,不得对
  // 自己发起 device-link 隧道。
  it('resolves refs pointing at the own device locally instead of tunneling', async () => {
    insertMessage(sqlite, { id: 'own', role: 'user', content: 'own history', createdAt: 101 });
    const [context] = await resolveSessionReferences([
      { sessionId: 'local-session', deviceId: 'self-device' },
    ]);
    expect(context.messages).toEqual([{ role: 'user', content: 'own history', createdAt: 101 }]);
    expect(context.source).toBe('local');
    expect(remoteInvoke).not.toHaveBeenCalled();
  });
});
