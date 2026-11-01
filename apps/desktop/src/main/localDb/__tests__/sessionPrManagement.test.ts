/**
 * Production PR store regressions for user-approved manual management.
 * No existing store tests exercise persistence, extraction or recomputation together.
 * Minimal failure: remove one automatically extracted URL, then scan it again.
 * Tier: db (real in-memory SQLite, no account, network or filesystem data).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { messages, sessionPrRefs, sessions } from '../schema';
import {
  managePrRefs,
  listPrRefs,
  recordPrRefsForMessage,
  recomputePrRefsForSession,
} from '../../git-context/prRefsStore';

const h = vi.hoisted(() => ({ client: null as unknown, changed: vi.fn() }));
vi.mock('../client/current', () => ({
  getDbClient: () => h.client,
  getCurrentDbClientUserId: () => 'test',
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
const sqlite = new Database(':memory:');
const db = drizzle(sqlite);
h.client = { drizzle: db };
for (const table of [sessions, messages, sessionPrRefs] as SQLiteTable[]) {
  const config = getTableConfig(table);
  sqlite.exec(
    `CREATE TABLE "${config.name}" (${config.columns.map((c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(', ')})`,
  );
}
sqlite.exec('CREATE UNIQUE INDEX pr_identity ON session_pr_refs(session_id,owner,repo,pr_number)');
const verify = vi.fn(async () => undefined);
const add = (number: number) =>
  managePrRefs(
    's',
    { action: 'add', url: `https://github.com/example/repo/pull/${number}` },
    verify,
  );
beforeEach(() => {
  sqlite.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM session_pr_refs;');
  db.insert(sessions)
    .values({
      id: 's',
      title: 'fixture',
      workingDir: '/fixture',
      source: 'desktop',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  verify.mockClear();
});
afterAll(() => sqlite.close());

describe('manual PR management', () => {
  it('removal survives automatic rescans and recomputation, then explicitly restores', async () => {
    await recordPrRefsForMessage({
      sessionId: 's',
      role: 'user',
      content: 'https://github.com/example/repo/pull/1',
      createdAt: 1,
    });
    const [ref] = await listPrRefs('s');
    await managePrRefs('s', { action: 'remove', id: ref.id }, verify);
    await recordPrRefsForMessage({
      sessionId: 's',
      role: 'assistant',
      content: ref.url,
      createdAt: 2,
    });
    await recomputePrRefsForSession('s');
    expect(await listPrRefs('s')).toEqual([]);
    const removed = await managePrRefs('s', { action: 'list' }, verify);
    expect(removed).toHaveLength(1);
    await managePrRefs('s', { action: 'restore', id: ref.id }, verify);
    expect(await listPrRefs('s')).toMatchObject([{ id: ref.id, removedAt: null }]);
  });

  it('manual links survive history recomputation and duplicate URLs are rejected', async () => {
    await add(2);
    await recomputePrRefsForSession('s');
    expect(await listPrRefs('s')).toMatchObject([{ prNumber: 2, manuallyAdded: true }]);
    await expect(add(2)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed links and API-confirmed missing PRs before storing anything', async () => {
    for (const url of [
      'https://github.com/example/repo/issues/1',
      'https://github.com.evil.test/example/repo/pull/1',
      'https://github.com/example/repo/pull/1junk',
    ]) {
      await expect(managePrRefs('s', { action: 'add', url }, verify)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }
    verify.mockRejectedValueOnce(Object.assign(new Error('not a PR'), { code: 'NOT_FOUND' }));
    await expect(add(3)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listPrRefs('s')).toEqual([]);
  });

  it('enforces three pins under concurrent requests and preserves priority across rescans', async () => {
    for (const n of [1, 2, 3, 4]) await add(n);
    const refs = await listPrRefs('s');
    const result = await Promise.allSettled(
      refs.map((ref) => managePrRefs('s', { action: 'pin', id: ref.id }, verify)),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rows = await listPrRefs('s');
    expect(rows.slice(0, 3).every((r) => r.pinned)).toBe(true);
    await managePrRefs(
      's',
      { action: 'reorder', ids: [rows[2].id, rows[0].id, rows[1].id] },
      verify,
    );
    await recordPrRefsForMessage({
      sessionId: 's',
      role: 'assistant',
      content: rows[0].url,
      createdAt: Date.now() + 1_000,
    });
    expect((await listPrRefs('s'))[0].id).toBe(rows[2].id);
  });

  // DB regression: whole-group reordering must persist atomically and reject
  // stale/foreign groups. Existing priority coverage only moved one pinned row.
  it('reorders each full group and rejects mixed, partial, duplicate, removed and foreign IDs', async () => {
    for (const n of [1, 2, 3, 4, 5]) await add(n);
    const refs = await listPrRefs('s');
    const [a, b, c, d, removed] = refs;
    db.update(sessionPrRefs)
      .set({ manuallyAdded: false })
      .where(eq(sessionPrRefs.sessionId, 's'))
      .run();
    await managePrRefs('s', { action: 'pin', id: a.id }, verify);
    await managePrRefs('s', { action: 'pin', id: b.id }, verify);
    await managePrRefs('s', { action: 'remove', id: removed.id }, verify);
    await managePrRefs('s', { action: 'reorder', ids: [b.id, a.id] }, verify);
    const result = await managePrRefs('s', { action: 'reorder', ids: [d.id, c.id] }, verify);
    expect(result.filter((r) => r.removedAt === null).map((r) => r.id)).toEqual([
      b.id,
      a.id,
      d.id,
      c.id,
    ]);
    expect((await listPrRefs('s')).every((r) => r.manuallyAdded)).toBe(true);
    db.insert(sessions)
      .values({
        id: 'other',
        title: 'other',
        workingDir: '/fixture',
        source: 'desktop',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const [foreign] = await managePrRefs(
      'other',
      { action: 'add', url: 'https://github.com/example/repo/pull/6' },
      verify,
    );
    for (const ids of [
      [a.id, c.id],
      [a.id],
      [a.id, a.id],
      [d.id, removed.id],
      [d.id, foreign.id],
      [],
    ]) {
      await expect(managePrRefs('s', { action: 'reorder', ids }, verify)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
      expect((await listPrRefs('s')).map((r) => r.id)).toEqual([b.id, a.id, d.id, c.id]);
    }
  });

  it('rejects other-task row IDs and a missing task', async () => {
    await expect(managePrRefs('missing', { action: 'list' }, verify)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      managePrRefs('s', { action: 'remove', id: 'unrelated' }, verify),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    db.update(sessions).set({ source: 'review' }).where(eq(sessions.id, 's')).run();
    await expect(add(1)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(verify).not.toHaveBeenCalled();
  });
});
