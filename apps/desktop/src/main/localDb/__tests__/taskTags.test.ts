import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runTaskTagsTransaction } from '../worker/opHandlers/taskTagsTx';
import type Database from 'better-sqlite3';

describe('task labels transactions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT DEFAULT 'active',source TEXT DEFAULT 'desktop',updated_at INTEGER DEFAULT 1); CREATE TABLE bot_session_links(session_id TEXT); INSERT INTO sessions(id) VALUES('a'),('b');",
    );
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0110_abandoned_scarlet_witch.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0111_messy_newton_destine.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0112_backfill_task_tag_order.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  afterEach(() => db.close());
  const run = (input: unknown) => runTaskTagsTransaction(db, input);
  it('seeds exactly seven favorites, preserves unrelated tags and is idempotent', () => {
    expect(run({ action: 'list' }).tags).toHaveLength(7);
    run({ action: 'attach', sessionIds: ['a'], tagIds: ['default:red'] });
    run({ action: 'attach', sessionIds: ['a', 'b'], tagIds: ['default:blue'] });
    const again = run({ action: 'attach', sessionIds: ['a'], tagIds: ['default:blue'] });
    expect(again.sessions[0].tags.map((t) => t.id).sort()).toEqual(['default:blue', 'default:red']);
    expect(
      run({ action: 'detach', sessionIds: ['a'], tagIds: ['default:red'] }).sessions[0].tags.map(
        (t) => t.id,
      ),
    ).toEqual(['default:blue']);
  });
  it('rolls back batches with missing tasks or invalid tags', () => {
    expect(() =>
      run({ action: 'attach', sessionIds: ['a', 'missing'], tagIds: ['default:red'] }),
    ).toThrow('NOT_FOUND');
    expect(run({ action: 'get', sessionIds: ['a'] }).sessions[0].tags).toEqual([]);
    expect(() =>
      run({ action: 'attach', sessionIds: ['a'], tagIds: ['default:red', 'missing'] }),
    ).toThrow('NOT_FOUND');
    expect(run({ action: 'get', sessionIds: ['a'] }).sessions[0].tags).toEqual([]);
  });
  it('rejects stale delete previews even when association count stays unchanged', () => {
    run({ action: 'attach', sessionIds: ['a'], tagIds: ['default:red'] });
    const preview = run({ action: 'previewDelete', tagId: 'default:red' }).deletion!;
    run({ action: 'detach', sessionIds: ['a'], tagIds: ['default:red'] });
    run({ action: 'attach', sessionIds: ['b'], tagIds: ['default:red'] });
    expect(() =>
      run({
        action: 'delete',
        tagId: 'default:red',
        revision: preview.revision,
        expectedCount: preview.count,
      }),
    ).toThrow('CONFLICT');
  });
  it('deletes associations including archives, retaining tasks and other tags', () => {
    db.exec("UPDATE sessions SET status='archived' WHERE id='b'");
    run({ action: 'attach', sessionIds: ['a', 'b'], tagIds: ['default:red', 'default:blue'] });
    const preview = run({ action: 'previewDelete', tagId: 'default:red' }).deletion!;
    const result = run({
      action: 'delete',
      tagId: preview.tagId,
      revision: preview.revision,
      expectedCount: preview.count,
    });
    expect(result.sessions).toHaveLength(0);
    const remaining = run({ action: 'get', sessionIds: ['a', 'b'] });
    expect(remaining.sessions.every((s) => s.tags.length === 1)).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  });
  it('excludes deleted tasks from previews while retaining archives and cleaning all associations', () => {
    db.exec("INSERT INTO sessions(id,status) VALUES('c','archived')");
    run({ action: 'attach', sessionIds: ['a', 'b', 'c'], tagIds: ['default:red'] });
    const stale = run({ action: 'previewDelete', tagId: 'default:red' }).deletion!;
    db.exec("UPDATE sessions SET status='deleted' WHERE id='b'");
    expect(() =>
      run({
        action: 'delete',
        tagId: stale.tagId,
        revision: stale.revision,
        expectedCount: stale.count,
      }),
    ).toThrow('CONFLICT');
    const preview = run({ action: 'previewDelete', tagId: 'default:red' }).deletion!;
    expect(preview.count).toBe(2);
    run({
      action: 'delete',
      tagId: preview.tagId,
      revision: preview.revision,
      expectedCount: preview.count,
    });
    expect(db.prepare('SELECT count(*) AS n FROM session_task_tags').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 3 });
  });
  it('checks favorite cap, name uniqueness, colors and stale edit revisions', () => {
    expect(() =>
      run({ action: 'create', newId: 'x', name: 'Work', color: 'red', favorite: true }),
    ).toThrow('FAVORITES_FULL');
    expect(() => run({ action: 'create', newId: 'x', name: ' RED ', color: 'red' })).toThrow(
      'ALREADY_EXISTS',
    );
    expect(() => run({ action: 'create', newId: 'x', name: 'Work', color: 'invisible' })).toThrow(
      'INVALID_PARAMS',
    );
    run({ action: 'update', tagId: 'default:red', revision: 1, name: 'Urgent' });
    expect(() =>
      run({ action: 'update', tagId: 'default:red', revision: 1, color: 'blue' }),
    ).toThrow('CONFLICT');
  });
  it('denies missing and bot callers at the write transaction boundary', () => {
    expect(() =>
      run({ action: 'create', newId: 'x', name: 'Work', color: 'red', callerSessionId: 'missing' }),
    ).toThrow('NOT_FOUND');
    db.exec("INSERT INTO bot_session_links VALUES('a')");
    expect(() => run({ action: 'list', callerSessionId: 'a' })).toThrow('NOT_FOUND');
  });
  it('persists order across edits and projects it onto task associations', () => {
    const expectedOrder = run({ action: 'list' }).tags.map((t) => t.id);
    const tagIds = [...expectedOrder].reverse();
    const reordered = run({ action: 'reorder', tagIds, expectedOrder });
    expect(reordered.tags.map((t) => t.id)).toEqual(tagIds);
    const first = reordered.tags[0];
    run({ action: 'update', tagId: first.id, revision: first.revision, name: 'ZZZ' });
    run({ action: 'attach', sessionIds: ['a'], tagIds });
    expect(run({ action: 'get', sessionIds: ['a'] }).sessions[0].tags.map((t) => t.id)).toEqual(
      tagIds,
    );
    expect(() => run({ action: 'reorder', tagIds: expectedOrder, expectedOrder })).toThrow(
      'CONFLICT',
    );
    expect(() =>
      run({ action: 'reorder', tagIds: tagIds.slice(1), expectedOrder: tagIds }),
    ).toThrow();
    expect(run({ action: 'list' }).tags.map((t) => t.id)).toEqual(tagIds);
  });
  it('appends after legacy null positions and rejects stale catalog reorders', () => {
    db.exec("UPDATE task_tags SET sort_order=NULL WHERE id='default:red'");
    const expectedOrder = run({ action: 'list' }).tags.map((t) => t.id);
    const created = run({ action: 'create', newId: 'new', name: 'New', color: 'blue' });
    expect(created.tags.map((t) => t.id)).toEqual([...expectedOrder, 'new']);
    expect(created.tags.every((t) => Number.isInteger(t.sortOrder))).toBe(true);
    expect(() => run({ action: 'reorder', tagIds: expectedOrder, expectedOrder })).toThrow(
      'CONFLICT',
    );
  });
  it('accepts the twelve colors and converts legacy uncolored writes to white', () => {
    const supported = run({ action: 'list' }).supportedColors!;
    expect(supported).toHaveLength(12);
    expect(supported).not.toContain('none');
    for (const color of supported)
      run({ action: 'create', newId: 'new-' + color, name: 'New ' + color, color });
    const result = run({ action: 'create', newId: 'legacy', name: 'Legacy', color: 'none' });
    expect(result.tags.find((t) => t.id === 'legacy')?.color).toBe('white');
  });
  it('same standalone implementation executes in the legacy inline worker', () => {
    const embedded = new Function('return (' + runTaskTagsTransaction.toString() + ')')();
    expect(
      embedded(db, { action: 'attach', sessionIds: ['a'], tagIds: ['default:red'] }).sessions[0]
        .tags[0].color,
    ).toBe('red');
  });
});
