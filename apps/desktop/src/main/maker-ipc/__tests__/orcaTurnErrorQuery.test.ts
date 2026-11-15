import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../localDb/schema.js';

const state = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db }) }));

import { readLatestWorkerTurnError } from '../orcaTurnErrorQuery.js';

const SESSION_ID = 'worker-session-1';

let sqlite: Database.Database;

/**
 * 最小 DDL:只建这个查询真正引用到的列。
 *
 * ⚠️ id 必须是 TEXT PRIMARY KEY(与生产 schema 一致):SQLite 的隐式 rowid 只有在表没有
 * INTEGER PRIMARY KEY 时才独立存在;写成 `id INTEGER PRIMARY KEY` 会让 id 直接别名
 * rowid,「同毫秒靠插入序定序」这条判据就测不出来了。也不要加 WITHOUT ROWID。
 */
function createDb(): Database.Database {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cleared_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  state.db = drizzle(raw, { schema: { messages, sessions } });
  return raw;
}

function seedSession(clearedAt: number | null = null): void {
  sqlite
    .prepare(`INSERT INTO sessions (id, title, cleared_at) VALUES (?, 'Worker', ?)`)
    .run(SESSION_ID, clearedAt);
}

/**
 * 插入顺序 == SQLite 的 rowid 顺序。
 * 「同毫秒、不同插入序」只能靠 INSERT 的先后造出来(rowid 自增),不能靠 created_at,
 * 也不应该显式指定 rowid。
 */
function seedMessage(input: {
  id: string;
  role: string;
  content: unknown;
  createdAt: number;
  rewindAt?: number | null;
  sessionId?: string;
}): void {
  sqlite
    .prepare(`
      INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at)
      VALUES (@id, @id, @sessionId, @role, @content, @createdAt, @rewindAt)
    `)
    .run({
      id: input.id,
      sessionId: input.sessionId ?? SESSION_ID,
      role: input.role,
      content: JSON.stringify(input.content),
      createdAt: input.createdAt,
      rewindAt: input.rewindAt ?? null,
    });
}

beforeEach(() => {
  sqlite = createDb();
  seedSession();
});
afterEach(() => sqlite.close());

describe('readLatestWorkerTurnError', () => {
  it('returns the summary while the error row is still the session tail', async () => {
    seedMessage({ id: 'm1', role: 'user', content: 'go', createdAt: 1000 });
    seedMessage({ id: 'e1', role: 'error', content: { message: 'boom' }, createdAt: 1001 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toEqual({
      message: 'boom',
      createdAt: 1001,
    });
  });

  // ① 新消息插在 error 之后 → 本轮已经不是那一轮了, 必须返回 null
  it('returns null once a newer message lands after the error row', async () => {
    seedMessage({ id: 'e1', role: 'error', content: { message: 'stale' }, createdAt: 1000 });
    seedMessage({ id: 'm2', role: 'user', content: 'retry', createdAt: 1001 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toBeNull();
  });

  // ② 同毫秒靠 rowid 定序: error 后插入 → 它是尾行
  it('orders same-millisecond rows by insertion order — error inserted last wins', async () => {
    seedMessage({ id: 'm1', role: 'user', content: 'go', createdAt: 1000 });
    seedMessage({ id: 'e1', role: 'error', content: { message: 'tail-error' }, createdAt: 1000 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toMatchObject({
      message: 'tail-error',
      createdAt: 1000,
    });
  });

  // ② 同毫秒靠 rowid 定序: error 先插入 → 被后到的同毫秒行挤掉
  it('orders same-millisecond rows by insertion order — error inserted first loses', async () => {
    seedMessage({ id: 'e1', role: 'error', content: { message: 'stale-error' }, createdAt: 1000 });
    seedMessage({ id: 'm2', role: 'user', content: 'go', createdAt: 1000 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toBeNull();
  });

  // ③ rewind 过的 error 行自己不算
  it('ignores an error row that was itself rewound', async () => {
    seedMessage({
      id: 'e1',
      role: 'error',
      content: { message: 'boom' },
      createdAt: 1000,
      rewindAt: 2000,
    });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toBeNull();
  });

  // ③ NOT EXISTS 两侧都要 rewind_at IS NULL: 只有后随行被 rewind 时 error 仍是尾行
  it('keeps the error row when only the later row was rewound', async () => {
    seedMessage({ id: 'e1', role: 'error', content: { message: 'boom' }, createdAt: 1000 });
    seedMessage({
      id: 'm2',
      role: 'user',
      content: 'gone',
      createdAt: 1001,
      rewindAt: 2000,
    });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toMatchObject({
      message: 'boom',
    });
  });

  // ④ /clear 边界是严格大于: 等于 cleared_at 的 error 行已不可见
  it('excludes an error row at sessions.cleared_at', async () => {
    sqlite.prepare(`UPDATE sessions SET cleared_at = 1000 WHERE id = ?`).run(SESSION_ID);
    seedMessage({ id: 'e1', role: 'error', content: { message: 'before clear' }, createdAt: 1000 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toBeNull();
  });

  it('includes an error row strictly after sessions.cleared_at', async () => {
    sqlite.prepare(`UPDATE sessions SET cleared_at = 1000 WHERE id = ?`).run(SESSION_ID);
    seedMessage({ id: 'e2', role: 'error', content: { message: 'after clear' }, createdAt: 1001 });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toMatchObject({
      message: 'after clear',
    });
  });

  // 与红点查询 listErrorTailPendingRows 的唯一差异: 诊断出口故意不过滤 dismissed,
  // 用户点过「忽略」不该让「这一轮为什么终止」变成信息缺失。
  it('still reports a dismissed error (deliberate divergence from the red-dot query)', async () => {
    seedMessage({
      id: 'e1',
      role: 'error',
      content: { message: 'boom', dismissed: true },
      createdAt: 1000,
    });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toMatchObject({
      message: 'boom',
    });
  });

  it('returns null when the error content is not valid JSON', async () => {
    sqlite
      .prepare(`
        INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at)
        VALUES ('e1', 'e1', ?, 'error', 'not json', 1000, NULL)
      `)
      .run(SESSION_ID);

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toBeNull();
  });

  it('never reads another session error row', async () => {
    seedMessage({ id: 'e1', role: 'error', content: { message: 'mine' }, createdAt: 1000 });
    seedMessage({
      id: 'e2',
      role: 'error',
      content: { message: 'other' },
      createdAt: 2000,
      sessionId: 'other-session',
    });

    await expect(readLatestWorkerTurnError(SESSION_ID)).resolves.toMatchObject({
      message: 'mine',
    });
  });
});
