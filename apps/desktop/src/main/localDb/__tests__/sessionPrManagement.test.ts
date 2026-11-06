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
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn';
import { manageSessionPrs } from '../../git-context/manageSessionPrs';
import { messages, migrationMeta, sessionPrRefs, sessions } from '../schema';
import {
  managePrRefs,
  listPrRefs,
  recordPrRefsForMessage,
  recordPrRefsForImportedMessages,
  recomputePrRefsForSession,
  ensurePrRefsBackfill,
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
for (const table of [sessions, messages, sessionPrRefs, migrationMeta] as SQLiteTable[]) {
  const config = getTableConfig(table);
  sqlite.exec(
    `CREATE TABLE "${config.name}" (${config.columns.map((c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(', ')})`,
  );
}
sqlite.exec(
  'CREATE UNIQUE INDEX pr_identity ON session_pr_refs(session_id,provider,host,owner,repo,pr_number)',
);
const verify = vi.fn(async () => undefined);
const add = (number: number) =>
  managePrRefs(
    's',
    { action: 'add', url: `https://github.com/example/repo/pull/${number}` },
    verify,
  );
beforeEach(() => {
  h.client = { drizzle: db };
  sqlite.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM session_pr_refs; DELETE FROM migration_meta;');
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
  // DB: MR imports and manual adds share identity across namespace/host/provider.
  // Prior GitHub fixtures cannot detect cross-host collisions or dropped MR messages.
  it('imports multi-group MRs and adds the same number on another host without collision', async () => {
    const url = 'https://git.example.com/group/sub/project/-/merge_requests/7';
    db.insert(messages)
      .values({
        id: 'mr',
        clientId: 'mr',
        sessionId: 's',
        role: 'assistant',
        content: JSON.stringify(url),
        createdAt: 10,
      })
      .run();
    await recordPrRefsForImportedMessages('s');
    expect(await listPrRefs('s')).toMatchObject([
      {
        provider: 'gitlab',
        host: 'git.example.com',
        owner: 'group/sub',
        repo: 'project',
        prNumber: 7,
      },
    ]);
    const refs = await managePrRefs(
      's',
      { action: 'add', url: url.replace('git.example.com', 'other.example.com') },
      verify,
    );
    expect(refs).toHaveLength(2);
    await recomputePrRefsForSession('s');
    expect(await listPrRefs('s')).toHaveLength(2);
    db.update(messages)
      .set({ content: JSON.stringify('no MR remains') })
      .where(eq(messages.id, 'mr'))
      .run();
    await recomputePrRefsForSession('s');
    expect(await listPrRefs('s')).toMatchObject([{ host: 'other.example.com' }]);
    await expect(
      managePrRefs('s', { action: 'add', url: url.replace('https:', 'http:') }, verify),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(await manageSessionPrs('s', { action: 'list' }, verify, 'ui')).toMatchObject({ associations: [] });
    expect(await manageSessionPrs('s', { action: 'attach', pr: { repo: 'example/repo', number: 1 } }, verify, 'ui')).toMatchObject({ associations: [{ provider: 'github', prNumber: 1 }] });
    await expect(manageSessionPrs('s', { action: 'reorder', prs: [{ repo: 'example/repo', number: 1 }] }, verify, 'ui')).rejects.toThrow('UNSUPPORTED_PROVIDER');
  });

  it('keeps removed links out of active reads until explicit restore', async () => {
    const [ref] = await add(1);
    await managePrRefs('s', { action: 'remove', id: ref.id }, verify);
    db.insert(messages).values({ id: 'removed', clientId: 'removed', sessionId: 's', role: 'assistant', content: JSON.stringify(ref.url), createdAt: 10 }).run();
    await recordPrRefsForMessage({ id: 'removed', sessionId: 's', role: 'assistant', content: ref.url, createdAt: 10 });
    await expect(add(1)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await listPrRefs('s')).toEqual([]);
    const removed = await managePrRefs('s', { action: 'list' }, verify);
    expect(removed).toHaveLength(1);
    await managePrRefs('s', { action: 'restore', id: ref.id }, verify);
    expect(await listPrRefs('s')).toMatchObject([{ id: ref.id, removedAt: null }]);
  });

  it('repeated explicit adds are idempotent, legacy links remain recoverable', async () => {
    const [ref] = await add(2);
    await add(2);
    expect(verify).toHaveBeenCalledTimes(1);
    db.update(sessionPrRefs).set({ associationSource: 'legacy', manuallyAdded: false }).where(eq(sessionPrRefs.id, ref.id)).run();
    expect(await listPrRefs('s')).toEqual([]);
    expect(await managePrRefs('s', { action: 'list' }, verify)).toHaveLength(1);
    await add(2);
    expect(await listPrRefs('s')).toMatchObject([{ id: ref.id, associationSource: 'explicit' }]);
  });

  // Regression: explicit-only mode dropped fresh PRs and missed messages after v1 backfill.
  // Exercise production scan/import/backfill with real SQLite; metadata-only tests missed visibility.
  it('recovers missed visible messages even after the old backfill completed, once per database', async () => {
    db.insert(migrationMeta).values({ key: 'git_context_pr_refs_backfill_v1', value: 'done' }).run();
    db.update(sessions).set({ clearedAt: 10 }).where(eq(sessions.id, 's')).run();
    for (const [id, role, createdAt, rewindAt] of [
      ['1', 'assistant', 20, null], ['2', 'user', 30, null],
      ['3', 'tool_result', 40, null], ['4', 'assistant', 5, null],
      ['5', 'assistant', 50, 60], ['6', 'assistant', 70, null],
    ] as const) {
      db.insert(messages).values({ id, clientId: id, sessionId: 's', role,
        content: JSON.stringify(`https://github.com/example/repo/pull/${id}`), createdAt, rewindAt }).run();
    }
    const [removed] = await add(6);
    await managePrRefs('s', { action: 'remove', id: removed.id }, verify);
    await ensurePrRefsBackfill();
    expect((await listPrRefs('s')).map(r => r.prNumber)).toEqual([2, 1]);
    expect(await listPrRefs('s')).toMatchObject([
      { associationSource: 'explicit', associationOrigin: 'message', manuallyAdded: false },
      { associationSource: 'explicit', associationOrigin: 'message', manuallyAdded: false },
    ]);
    const first = await listPrRefs('s');
    h.client = { drizzle: db }; // reopening the same database must use the persisted marker
    await ensurePrRefsBackfill();
    expect(await listPrRefs('s')).toEqual(first);
  });

  it('imports mentions and preserves an explicitly adopted automatic link through clear', async () => {
    const url = 'https://github.com/example/repo/pull/7';
    db.insert(messages).values([
      { id: 'import-7', clientId: 'import-7', sessionId: 's', role: 'assistant', content: JSON.stringify(url), createdAt: 20 },
      { id: 'import-8', clientId: 'import-8', sessionId: 's', role: 'tool_result', content: JSON.stringify('https://github.com/example/repo/pull/8'), createdAt: 30 },
    ]).run();
    await recordPrRefsForImportedMessages('s');
    expect(await listPrRefs('s')).toMatchObject([{ prNumber: 7, manuallyAdded: false }]);
    await add(7);
    db.delete(messages).run();
    await recomputePrRefsForSession('s'); // no surviving messages: only explicit adoption survives
    expect(await listPrRefs('s')).toMatchObject([{ prNumber: 7, manuallyAdded: true, associationOrigin: 'ui' }]);
  });

  // Review regressions: real persisted rows, private App projection and stale scan races.
  it('extracts only public MCP App text during backfill and recompute', async () => {
    const url = (n: number) => `https://github.com/example/repo/pull/${n}`;
    db.insert(messages).values({ id: 'app', clientId: 'app', sessionId: 's', role: 'assistant',
      createdAt: 20, agentMeta: JSON.stringify({ mcpApp: true }),
      content: JSON.stringify({ mcpApp: { version: 1, serverId: 'fixture', serverRevision: '1',
        resourceUri: 'ui://fixture/app', tool: { name: 'save', inputSchema: { type: 'object' } },
        arguments: { privateUrl: url(91) }, result: { content: [{ type: 'text', text: url(90) }],
          structuredContent: { privateUrl: url(92) }, _meta: { privateUrl: url(93) } } } }) }).run();
    await ensurePrRefsBackfill();
    expect((await listPrRefs('s')).map(r => r.prNumber)).toEqual([90]);
    await recomputePrRefsForSession('s');
    expect((await listPrRefs('s')).map(r => r.prNumber)).toEqual([90]);
  });

  it('does not republish a backfill candidate hidden after discovery', async () => {
    db.insert(messages).values({ id: 'late', clientId: 'late', sessionId: 's', role: 'assistant',
      content: JSON.stringify('https://github.com/example/repo/pull/94'), createdAt: 20 }).run();
    const select = db.select.bind(db);
    let captured!: () => void, release!: () => void;
    const snapshot = new Promise<void>(resolve => { captured = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    const spy = vi.spyOn(db, 'select').mockImplementation((fields) => {
      const query = select(fields);
      const from = query.from.bind(query);
      vi.spyOn(query, 'from').mockImplementation((table) => {
        const builder = from(table);
        if (table === messages && !paused) {
          const orderBy = builder.orderBy.bind(builder);
          vi.spyOn(builder, 'orderBy').mockImplementationOnce((...columns) => {
            paused = true; const rows = orderBy(...columns).all(); captured();
            return resume.then(() => rows) as unknown as ReturnType<typeof orderBy>;
          });
        }
        return builder;
      });
      return query;
    });
    const scan = ensurePrRefsBackfill();
    try {
      await snapshot;
      db.update(messages).set({ rewindAt: 30 }).where(eq(messages.id, 'late')).run();
      await recomputePrRefsForSession('s');
      release(); await scan;
      expect(await listPrRefs('s')).toEqual([]);
    } finally { release(); spy.mockRestore(); await scan; }
  });

  it('ignores stale live and import candidates not visible in persisted history', async () => {
    const msg = { id: 'gone', sessionId: 's', role: 'assistant' as const,
      content: 'https://github.com/example/repo/pull/95', createdAt: 20 };
    await recordPrRefsForMessage(msg);
    db.insert(messages).values({ ...msg, clientId: msg.id, content: JSON.stringify(msg.content), rewindAt: 30 }).run();
    await recordPrRefsForMessage(msg);
    await recordPrRefsForImportedMessages('s');
    expect(await listPrRefs('s')).toEqual([]);
  });

  // Hidden recovery summaries copy PRs from assistant/thinking. All production
  // extraction entrances must ignore them, including after the visible row disappears.
  it.each([
    { kind: 'plain synthetic', content: `${UI_ACTION_TRIGGER_PREFIX} continue https://github.com/example/repo/pull/96 https://github.com/example/repo/pull/97`, agentMeta: null },
    { kind: 'enveloped synthetic', content: { text: `${UI_ACTION_TRIGGER_PREFIX} continue https://github.com/example/repo/pull/96 https://github.com/example/repo/pull/97`, images: [], files: [] }, agentMeta: null },
    { kind: 'autoResume', content: { text: 'continue https://github.com/example/repo/pull/96 https://github.com/example/repo/pull/97' }, agentMeta: { autoResume: true } },
  ])('does not retain PRs from a hidden $kind recovery row', async ({ content, agentMeta }) => {
    const msg = { id: 'hidden-recovery', sessionId: 's', role: 'user' as const, content, createdAt: 30 };
    db.insert(messages).values([
      { id: 'visible', clientId: 'visible', sessionId: 's', role: 'assistant', content: JSON.stringify('https://github.com/example/repo/pull/96'), createdAt: 20 },
      { ...msg, clientId: msg.id, content: JSON.stringify(content), agentMeta: agentMeta ? JSON.stringify(agentMeta) : null },
    ]).run();
    await recordPrRefsForMessage(msg);
    expect(await listPrRefs('s')).toEqual([]);
    await recordPrRefsForImportedMessages('s');
    expect((await listPrRefs('s')).map(r => r.prNumber)).toEqual([96]);
    await ensurePrRefsBackfill();
    expect((await listPrRefs('s')).map(r => r.prNumber)).toEqual([96]);
    db.delete(messages).where(eq(messages.id, 'visible')).run();
    await recomputePrRefsForSession('s');
    expect(await listPrRefs('s')).toEqual([]);
  });

  it('public selectors validate pagination before mutation and preserve repeated detach', async () => {
    const args = { action: 'attach', pr: { repo: 'example/repo', number: 8 } };
    await expect(manageSessionPrs('s', { ...args, limit: 0 }, verify, 'agent:test')).rejects.toThrow('INVALID_LIMIT');
    expect(await listPrRefs('s')).toEqual([]);
    await manageSessionPrs('s', args, verify, 'agent:test');
    const removed = await manageSessionPrs('s', { ...args, action: 'detach' }, verify, 'agent:test');
    const again = await manageSessionPrs('s', { ...args, action: 'detach' }, verify, 'agent:test');
    expect(again.associations).toEqual(removed.associations);
    expect(await listPrRefs('s')).toEqual([]);
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

  // Verification releases the task write lock; commit must re-read removals
  // and reject a replaced account rather than publishing its earlier snapshot.
  it.each(['removed', 'account-changed'] as const)('revalidates a pending add after %s', async change => {
    const ref = { id: 'pending-manual', sessionId: 's', owner: 'example', repo: 'repo', prNumber: 98,
      url: 'https://github.com/example/repo/pull/98', firstSeenAt: 1, lastSeenAt: 1,
      associationSource: 'explicit', manuallyAdded: false, removedAt: null };
    db.insert(sessionPrRefs).values(ref).run();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verifying = new Promise<void>(resolve => { entered = resolve; });
    const adding = managePrRefs('s', { action: 'add', url: ref.url }, async () => { entered(); await gate; })
      .then(result => ({ result, error: null }), error => ({ result: null, error }));
    await verifying;
    let removing: Promise<unknown> | undefined;
    try {
      if (change === 'removed') {
        removing = managePrRefs('s', { action: 'remove', id: ref.id }, verify);
        expect(await Promise.race([removing.then(() => 'settled'),
          new Promise<string>(resolve => setImmediate(() => resolve('blocked')))])).toBe('settled');
      } else h.client = { drizzle: db }; // same data fixture, replacement owner client
      release();
      const outcome = await adding;
      expect(outcome.error).toMatchObject({ code: change === 'removed' ? 'ALREADY_EXISTS' : 'PERMISSION_DENIED' });
      expect(db.select().from(sessionPrRefs).all()).toMatchObject([{ manuallyAdded: false }]);
    } finally { release(); await adding; await removing; }
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
