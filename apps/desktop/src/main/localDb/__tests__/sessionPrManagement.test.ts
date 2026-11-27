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
import { eq, isNull } from 'drizzle-orm';
import type { NavigateSessionTreeResult } from '@cindy/maker-core';
import type { CurrentDbClientSnapshot } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { tx as runTx } from '../worker/opHandlers/tx';
import { navigateAndRehydrateSessionTree, assertSessionTreeOwner } from '../../maker-ipc/sessionTreeNavigation';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn';
import { manageSessionPrs } from '../../git-context/manageSessionPrs';
import { messages, migrationMeta, sessionPrRefs, sessions } from '../schema';
import {
  managePrRefs,
  listPrRefs,
  listAllPrRefs,
  recordPrRefsForMessage,
  recordPrRefsForImportedMessages,
  recomputePrRefsForSession,
  ensurePrRefsBackfill,
  setPrRefsChangedListener,
} from '../../git-context/prRefsStore';

const h = vi.hoisted(() => ({ client: null as unknown, owner: null as CurrentDbClientSnapshot | null, changed: vi.fn() }));
vi.mock('../client/current', () => ({
  getDbClient: () => h.client,
  getCurrentDbClientSnapshot: () => h.owner,
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
sqlite.exec('CREATE UNIQUE INDEX message_identity ON messages(session_id,client_id)');
const verify = vi.fn(async () => undefined);
const add = (number: number) =>
  managePrRefs(
    's',
    { action: 'add', url: `https://github.com/example/repo/pull/${number}` },
    verify,
  );
beforeEach(() => {
  h.client = { drizzle: db, tx: async (name: string, args: unknown) => runTx(sqlite, { name, args }) };
  h.owner = { client: h.client as DbClient, userId: 'test', clientEpoch: 1 };
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
  h.changed.mockClear();
  setPrRefsChangedListener(h.changed);
});
afterAll(() => sqlite.close());

describe('manual PR management', () => {
  // DB regression: notifications caused redundant window reads/status queries.
  // Existing persistence tests miss no-op imports and intermediate timestamp
  // changes during full recomputation; use the public store with real SQLite.
  it('notifies only for final association changes, including mention ordering', async () => {
    const url = 'https://github.com/example/repo/pull/1';
    const first = { id: 'first', clientId: 'first', sessionId: 's',
      role: 'assistant' as const, content: JSON.stringify(url), createdAt: 10 };
    await recordPrRefsForImportedMessages('s');
    expect(h.changed).not.toHaveBeenCalled();
    db.insert(messages).values(first).run();
    await recordPrRefsForMessage({ ...first, content: url });
    expect(h.changed).toHaveBeenCalledTimes(1);
    await recordPrRefsForImportedMessages('s');
    expect(h.changed).toHaveBeenCalledTimes(1);

    const later = { ...first, id: 'later', clientId: 'later', createdAt: 20 };
    db.insert(messages).values(later).run();
    await recordPrRefsForMessage({ ...later, content: url });
    expect(h.changed).toHaveBeenCalledTimes(2);
    expect(await listPrRefs('s')).toMatchObject([{ firstSeenAt: 10, lastSeenAt: 20 }]);
    // Full recomputation temporarily sets lastSeenAt to 10, then back to 20.
    await recomputePrRefsForSession('s');
    expect(h.changed).toHaveBeenCalledTimes(2);
    db.update(messages).set({ content: JSON.stringify('Edited text without a link') })
      .where(eq(messages.id, 'later')).run();
    await recomputePrRefsForSession('s');
    expect(h.changed).toHaveBeenCalledTimes(3);
    expect(await listPrRefs('s')).toMatchObject([{ lastSeenAt: 10 }]);
    db.delete(messages).run();
    await recomputePrRefsForSession('s');
    expect(h.changed).toHaveBeenCalledTimes(4);
    expect(await listPrRefs('s')).toEqual([]);
    await recomputePrRefsForSession('s');
    expect(h.changed).toHaveBeenCalledTimes(4);
  });

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

  // DB regression: old add priorities (wall-clock ms) hid newer message refs.
  // Existing tests cover manual ordering, but never mix adds with later messages.
  // All three public read paths must expose the latest three without losing pins/reorder.
  // Exported priority must also match SQL order: Mobile re-sorts these returned rows.
  it('replaces older added PRs with recent mentions, including legacy add priorities', async () => {
    const start = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now');
    try {
      for (const n of [1, 2, 3]) {
        clock.mockReturnValue(start + n);
        await add(n);
      }
      // Persisted values from versions that assigned timestamps on add.
      db.update(sessionPrRefs).set({ priority: start }).where(eq(sessionPrRefs.prNumber, 1)).run();
      db.insert(messages).values({ id: 'recent', clientId: 'recent', sessionId: 's',
        role: 'assistant', content: JSON.stringify('https://github.com/example/repo/pull/4'),
        createdAt: start + 10 }).run();
      await recordPrRefsForImportedMessages('s');
      const reads = [() => listPrRefs('s'), listAllPrRefs,
        () => managePrRefs('s', { action: 'list' }, verify)];
      for (const read of reads) {
        const rows = await read();
        expect(rows.slice(0, 3).map(r => r.prNumber)).toEqual([4, 3, 2]);
        expect(rows.map(r => r.priority)).toEqual([0, 0, 0, 0]);
      }
      const refs = await listPrRefs('s');
      const oldest = refs.find(r => r.prNumber === 1)!;
      await managePrRefs('s', { action: 'pin', id: oldest.id }, verify);
      expect((await listPrRefs('s'))[0].prNumber).toBe(1);
      const unpinned = refs.filter(r => r.id !== oldest.id).reverse();
      await managePrRefs('s', { action: 'reorder', ids: unpinned.map(r => r.id) }, verify);
      for (const read of reads) {
        const rows = await read();
        expect(rows.map(r => r.prNumber)).toEqual([1, 2, 3, 4]);
        expect(rows.map(r => r.priority)).toEqual([0, 3, 2, 1]);
      }
    } finally { clock.mockRestore(); }
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

  // Regression: explicit-only mode dropped fresh PRs and missed messages after v3 backfill.
  // Exercise production scan/import/backfill with real SQLite; metadata-only tests missed visibility.
  it('recovers missed visible messages even after the old backfill completed, once per database', async () => {
    db.insert(migrationMeta).values({ key: 'git_context_pr_refs_backfill_v3', value: 'done' }).run();
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

// #8529: the navigation production path, real treeRehydrate and public PR store.
// Existing tests call recompute directly and miss this missing navigation hook.
// Minimal failure: A mentions /pull/111, native navigation projects B /pull/222.
// DB tier reuses the file's one in-memory fixture; no RPC, account or disk access.
describe('native tree navigation PR projection', () => {
  const branch = (name: string, pr: number): NavigateSessionTreeResult => ({
    tree: { roots: [], leafId: name, activePathIds: [name] },
    messages: [{ clientId: name, role: 'assistant', createdAt: pr,
      content: { text: `https://github.com/example/repo/pull/${pr}` } }],
    contextTokens: 10, contextWindow: 200000, draftText: 'preserved draft',
  });
  const navigate = (result: NavigateSessionTreeResult) =>
    navigateAndRehydrateSessionTree('s', h.owner!, async () => result);
  async function seedA() {
    const result = branch('a', 111);
    const message = result.messages[0];
    db.insert(messages).values({ ...message, id: 'a', sessionId: 's',
      content: JSON.stringify(message.content), agentMeta: null }).run();
    await recordPrRefsForImportedMessages('s');
    db.insert(migrationMeta).values({ key: 'git_context_pr_refs_backfill_v2', value: 'done' }).run();
    return result;
  }

  it('follows A→B→A and empty history without reviving removals or losing manual order', async () => {
    const a = await seedA();
    const [manual] = await add(333);
    await managePrRefs('s', { action: 'pin', id: manual.id }, verify);
    await managePrRefs('s', { action: 'reorder', ids: [manual.id] }, verify);
    await add(444);
    const removed = (await listPrRefs('s')).find(ref => ref.prNumber === 444)!;
    await managePrRefs('s', { action: 'remove', id: removed.id }, verify);
    const before = db.select().from(sessionPrRefs).where(eq(sessionPrRefs.id, manual.id)).get();
    const b = branch('b', 222);
    b.messages.push(
      { clientId: 'removed', role: 'user', createdAt: 223, content: 'https://github.com/example/repo/pull/444' },
      { clientId: 'tool', role: 'tool_result', createdAt: 224, content: 'https://github.com/example/repo/pull/555' },
      { clientId: 'private', role: 'assistant', createdAt: 225,
        agentMeta: { mcpApp: true },
        content: { mcpApp: { version: 1, serverId: 'fixture', serverRevision: '1',
          resourceUri: 'ui://fixture/app', tool: { name: 'save', inputSchema: { type: 'object' } },
          arguments: { privateUrl: 'https://github.com/example/repo/pull/666' },
          result: { content: [{ type: 'text', text: 'public result' }] } } } },
    );
    const projected = await navigate(b);
    expect(projected.result.draftText).toBe('preserved draft');
    expect(projected.hiddenClientIds).toEqual(['a']);
    expect(db.select().from(messages).where(isNull(messages.rewindAt)).all().map(row => row.clientId))
      .toEqual(['b', 'removed', 'tool', 'private']);
    expect((await listPrRefs('s')).map(ref => ref.prNumber)).toEqual([333, 222]);
    expect(db.select().from(sessionPrRefs).where(eq(sessionPrRefs.id, manual.id)).get()).toEqual(before);
    expect(db.select().from(sessionPrRefs).where(eq(sessionPrRefs.id, removed.id)).get()).toMatchObject({ removedAt: expect.any(Number) });
    await navigate(a);
    expect((await listPrRefs('s')).map(ref => ref.prNumber)).toEqual([333, 111]);
    await navigate({ ...a, messages: [] });
    expect((await listPrRefs('s')).map(ref => ref.prNumber)).toEqual([333]);
  });

  it.each(['native failure', 'transaction failure', 'cancelled'] as const)(
    'preserves persisted history and refs on %s', async mode => {
      await seedA();
      h.changed.mockClear();
      const b = branch('b', 222);
      if (mode === 'native failure') {
        await expect(navigateAndRehydrateSessionTree('s', h.owner!, async () => {
          throw new Error('native failure');
        })).rejects.toThrow('native failure');
      } else if (mode === 'transaction failure') {
        sqlite.exec("CREATE TEMP TRIGGER reject_projection BEFORE INSERT ON messages WHEN NEW.client_id = 'b' BEGIN SELECT RAISE(ABORT, 'projection rejected'); END");
        try {
          await expect(navigate(b)).rejects.toThrow('projection rejected');
        } finally { sqlite.exec('DROP TRIGGER reject_projection'); }
      } else {
        expect((await navigate({ ...b, cancelled: true })).result.cancelled).toBe(true);
      }
      expect(db.select().from(messages).where(isNull(messages.rewindAt)).all().map(row => row.clientId)).toEqual(['a']);
      expect((await listPrRefs('s')).map(ref => ref.prNumber)).toEqual([111]);
      expect(h.changed).not.toHaveBeenCalled();
    },
  );

  it.each(['before navigation', 'native result', 'committed projection'] as const)(
    'rejects stale account generation at %s without PR writes/publication', async stage => {
      await seedA();
      h.changed.mockClear();
      const owner = h.owner!;
      const native = vi.fn(async () => {
        if (stage === 'native result') h.owner = { ...owner, clientEpoch: 2 };
        return branch('b', 222);
      });
      if (stage === 'before navigation') {
        h.owner = null;
        expect(() => assertSessionTreeOwner(null)).toThrow('DbClient not ready');
      }
      if (stage === 'committed projection') {
        const client = h.client as { tx(name: string, args: unknown): Promise<unknown> };
        const tx = client.tx.bind(client);
        client.tx = async (name, args) => {
          const result = await tx(name, args);
          h.owner = { ...owner, clientEpoch: 2 };
          return result;
        };
      }
      await expect(navigateAndRehydrateSessionTree('s', owner, native)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      if (stage === 'before navigation') expect(native).not.toHaveBeenCalled();
      expect((await listPrRefs('s')).map(ref => ref.prNumber)).toEqual([111]);
      expect(h.changed).not.toHaveBeenCalled();
      expect(() => assertSessionTreeOwner(owner)).toThrow('account changed');
    },
  );
});
