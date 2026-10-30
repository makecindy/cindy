import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutoReviewIntentProjection } from '@cindy/maker-shared/auto-review-intent';
import {
  batchAutoReviewProjection,
  readAutoReviewProjection,
  readAutoReviewProjectionTransaction,
} from '../autoReviewProjection.js';

const migration = fs.readFileSync(path.resolve('drizzle/0122_auto_review_projections.sql'), 'utf8');
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function open(filename = ':memory:', init = true) {
  const db = new Database(filename);
  databases.push(db);
  db.pragma('foreign_keys = ON');
  if (init) {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, cleared_at INTEGER);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT,
        content TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);
      INSERT INTO sessions(id) VALUES ('lead'),('worker');`);
    db.exec(migration);
    const companion = fs.readFileSync(
      path.resolve('drizzle/scripts/0122_auto_review_projections.ts'),
      'utf8',
    );
    const module = { exports: {} as { run?: (db: Database.Database) => void } };
    new Function('module', companion)(module);
    module.exports.run!(db);
  }
  return db;
}
function add(
  db: Database.Database,
  id: string,
  session = 'lead',
  at = 1,
  text = 'read only',
  role = 'user',
  meta: unknown = { delivery: 'turn', autoReviewUserText: text },
) {
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL)').run(
    id,
    session,
    id,
    role,
    JSON.stringify({ text }),
    at,
    JSON.stringify(meta),
  );
}
function read(db: Database.Database) {
  return readAutoReviewProjectionTransaction(db, { sessionId: 'worker', leadId: 'lead' });
}
function stored(db: Database.Database) {
  return db.prepare('SELECT * FROM auto_review_projections').get() as {
    payload: string;
    revision: number;
    projected_revision: number;
  };
}

describe('durable Auto authority projection', () => {
  it.each(['insert', 'answer', 'delete', 'clear', 'rewind'])(
    'keeps %s writes and rebuilds evidence after corrupt summaries with live and legacy connections',
    (operation) => {
      for (const live of [true, false]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-corrupt-projection-'));
        directories.push(dir);
        const filename = path.join(dir, 'test.sqlite');
        const db = open(filename);
        add(db, 'grant', 'worker', 1, 'allow');
        add(db, 'restriction', 'worker', 2, 'deny');
        add(db, 'answer', 'worker', 0, 'question', 'ask_user', {});
        read(db);
        db.prepare("UPDATE auto_review_projections SET payload='{broken'").run();
        const writer = live ? db : open(filename, false);
        expect(() => {
          writer.transaction(() => {
            if (operation === 'insert') add(writer, 'latest', 'worker', 4, 'never publish');
            if (operation === 'answer') writer.prepare('UPDATE messages SET agent_meta=? WHERE id=?').run(
              JSON.stringify({autoReviewUserText:{text:'never publish',acceptedAt:4}}), 'answer');
            if (operation === 'delete') writer.prepare("DELETE FROM messages WHERE id='grant'").run();
            if (operation === 'clear') writer.prepare("UPDATE sessions SET cleared_at=1 WHERE id='worker'").run();
            if (operation === 'rewind') writer.prepare("UPDATE messages SET rewind_at=4 WHERE id='grant'").run();
          })();
        }).not.toThrow();
        if (!live) expect(stored(writer).revision).not.toBe(stored(writer).projected_revision);
        const restored = read(writer);
        expect(JSON.stringify(restored.sessionIntent)).toContain('deny');
        if (operation === 'insert' || operation === 'answer')
          expect(JSON.stringify(restored.sessionIntent)).toContain('never publish');
        else expect(JSON.stringify(restored.sessionIntent)).not.toContain('allow');
        expect(stored(writer).revision).toBe(stored(writer).projected_revision);
      }
    },
  );

  it.each([
    { sessionIntent: {} },
    { reviewIntent: { currentUserMessage: 'allow' } },
    { sessionIntent: { currentUserMessage: 'allow', earlierUserMessages: [42] } },
    { reviewIntent: null },
    { sessionAmbiguous: 'false' },
    { reviewUnverified: null },
    { reviewIntent: 'x'.repeat(2001) },
    { lastEventAt: '1' },
  ])('rebuilds structurally corrupt summaries before append and direct read: %j', (damage) => {
    for (const append of [true, false]) {
      const db = open();
      add(db, 'grant', 'worker', 1, 'allow');
      add(db, 'restriction', 'lead', 2, 'read only');
      read(db);
      const original = JSON.parse(stored(db).payload);
      db.prepare('UPDATE auto_review_projections SET payload=?').run(
        JSON.stringify({ ...original, ...damage }),
      );
      if (append) {
        expect(() => add(db, 'latest', 'worker', 3, 'never publish')).not.toThrow();
        expect(db.prepare("SELECT count(*) AS n FROM messages WHERE id='latest'").get()).toEqual({ n: 1 });
      }
      const repaired = read(db);
      expect(JSON.stringify(repaired.reviewIntent)).toContain('read only');
      if (append) expect(JSON.stringify(repaired.sessionIntent)).toContain('never publish');
      // Force complete replay and compare both intents, not merely successful writes.
      db.prepare('UPDATE auto_review_projections SET projected_revision=-1').run();
      const replayed = read(db);
      expect(repaired.sessionIntent).toEqual(replayed.sessionIntent);
      expect(repaired.reviewIntent).toEqual(replayed.reviewIntent);
    }
  });

  it.each(['lead', 'worker'])('keeps literal trigger restrictions and rejects ambiguous provenance in %s', session => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-authority-literal-'));
    directories.push(dir);const filename=path.join(dir,'test.sqlite');const db=open(filename);
    add(db,'grant','worker',1,'publish');read(db);
    const text='[UI_ACTION_TRIGGER] do not publish';
    add(db,'restriction',session,2,text);
    add(db,'followup','worker',3,'continue');
    const incremental=read(db);
    expect(JSON.stringify(incremental.reviewIntent)).toContain(text);
    expect(incremental.reviewIntent).toMatchObject({historyOmitted:true});
    if(session==='worker') {
      expect(JSON.stringify(incremental.sessionIntent)).toContain(text);
      expect(incremental.sessionIntent).toMatchObject({historyOmitted:true});
    }
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL)').run(
      'resource', 'worker', 'resource', 'user', JSON.stringify({text:'use this file',files:[{}]}),
      4, JSON.stringify({delivery:'turn',autoReviewUserText:'use this file'}));
    const afterResource = read(db);
    if(session==='worker') expect(afterResource.sessionIntent).toMatchObject({historyOmitted:true});
    const old=JSON.parse(stored(db).payload);
    db.prepare('UPDATE auto_review_projections SET version=2,payload=?').run(JSON.stringify({...old,sessionIntent:'publish',reviewIntent:'publish',reviewUnverified:false}));
    const restarted=open(filename,false);
    const rebuilt=read(restarted);
    expect(rebuilt.sessionIntent).toEqual(afterResource.sessionIntent);
    expect(rebuilt.reviewIntent).toEqual(afterResource.reviewIntent);
    expect(restarted.prepare('SELECT version FROM auto_review_projections').get()).toEqual({version:3});
  });
  it.each([
    { autoResume: true, autoReviewUserText: 'allow' },
    { contextRebuild: { reason: 'recovery' }, autoReviewUserText: 'allow' },
    { autoReviewUserText: { kind: 'delegated-continuation' } },
    { autoReviewUserText: { kind: 'scheduled-continuation' } },
  ])('ignores synthetic recovery through incremental writes, restart and v1 upgrade: %j', (meta) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-authority-restart-'));
    directories.push(dir);
    const filename = path.join(dir, 'test.sqlite');
    const db = open(filename);
    add(db, 'grant', 'worker', 1, 'allow');
    add(db, 'revoke', 'worker', 2, 'never publish');
    const before = read(db);
    add(db, 'resume', 'worker', 3, 'allow', 'user', { delivery: 'turn', ...meta });
    expect(read(db)).toMatchObject({ sessionIntent: before.sessionIntent, reviewIntent: before.reviewIntent });
    // A previously valid old projection may contain exactly the stale grant
    // this upgrade fixes. Force a v1 receipt without invalidating its revision.
    const old = JSON.parse(stored(db).payload);
    db.prepare('UPDATE auto_review_projections SET version=1, payload=?').run(JSON.stringify({
      ...old, sessionIntent: '', reviewIntent: 'allow',
    }));
    const restarted = open(filename, false);
    expect(read(restarted)).toMatchObject({ sessionIntent: before.sessionIntent, reviewIntent: before.reviewIntent });
    expect(restarted.prepare('SELECT version FROM auto_review_projections').get()).toEqual({ version: 3 });
    add(restarted, 'reset', 'worker', 4, '');
    add(restarted, 'resume-again', 'worker', 5, 'allow', 'user', { delivery: 'steer', ...meta });
    expect(read(restarted)).toMatchObject({ sessionIntent: '', reviewIntent: '' });
  });
  it('rejects a stale projection when durable invalidation is missing', () => {
    const db = open();
    add(db, 'grant', 'worker', 1, 'allow');
    read(db);
    db.exec('DROP TRIGGER auto_review_message_insert');
    add(db, 'restriction', 'worker', 2, 'deny');
    expect(() => read(db)).toThrow('Authorization projection invalidation is unavailable');
  });

  it('reinstalls connection-local projection after temporary objects are cleared', () => {
    const db = open();
    add(db, 'grant', 'worker', 1, 'allow');
    read(db);
    db.pragma('temp_store = MEMORY');
    add(db, 'restriction', 'worker', 2, 'deny');
    expect(read(db).sessionIntent).toEqual({
      earlierUserMessages: ['allow'],
      currentUserMessage: 'deny',
    });
    expect(stored(db).revision).toBe(stored(db).projected_revision);
  });

  it('incremental appends exactly match complete replay across budget cycles and resource resets', () => {
    const db = open();
    const projector = createAutoReviewIntentProjection();
    read(db);
    for (let i = 1; i <= 240; i++) {
      const text =
        i % 11 === 0
          ? ''
          : i % 17 === 0
            ? 'long '.repeat(500)
            : `instruction ${i} ${'detail '.repeat(8)}`;
      add(
        db,
        String(i),
        i % 3 ? 'worker' : 'lead',
        i,
        text,
        'user',
        i % 13 === 0 ? {} : { delivery: 'steer', autoReviewUserText: text },
      );
      if (i % 19 === 0)
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(
          JSON.stringify({ text, files: [{}] }),
          String(i),
        );
      const history = db
        .prepare(
          'SELECT session_id AS sessionId, client_id AS clientId, role, content, created_at AS createdAt, agent_meta AS agentMeta FROM messages ORDER BY created_at,rowid',
        )
        .all()
        .map((row: any) => ({ ...row, agentMeta: JSON.parse(row.agentMeta) }));
      expect(read(db).sessionIntent).toEqual(
        projector.restore(history.filter((row) => row.sessionId === 'worker')),
      );
      expect(read(db).reviewIntent).toEqual(projector.review(history));
    }
  });

  it('does not replay old rows for normal inserts, and batches import rewrites into one replay', () => {
    const db = open();
    for (let i = 1; i <= 100; i++) add(db, String(i), 'worker', i);
    let fullReplays = 0;
    const factory = () => {
      const p = createAutoReviewIntentProjection();
      return {
        ...p,
        restore: (...args: Parameters<typeof p.restore>) => {
          if (args[0].length > 1) fullReplays++;
          return p.restore(...args);
        },
      };
    };
    readAutoReviewProjection(db, { sessionId: 'worker', leadId: 'lead' }, factory);
    expect(fullReplays).toBe(1);
    for (let i = 101; i <= 200; i++) add(db, String(i), 'worker', i);
    expect(fullReplays).toBe(1);
    batchAutoReviewProjection(db, 'session.treeRehydrate', () => {
      for (let i = 1; i <= 100; i++)
        db.prepare('UPDATE messages SET rewind_at=1 WHERE id=?').run(String(i));
    });
    expect(fullReplays).toBe(2);
    expect(stored(db).revision).toBe(stored(db).projected_revision);
    const before = stored(db);
    expect(() =>
      batchAutoReviewProjection(db, 'session.treeRehydrate', () => {
        db.prepare('DELETE FROM messages').run();
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(stored(db)).toEqual(before);
    expect(
      (db.prepare('SELECT depth FROM auto_review_projection_batch').get() as { depth: number })
        .depth,
    ).toBe(0);
  });
  it('backfills legacy rows once; every unchanged Auto read is bounded and does not read messages', () => {
    const db = open();
    for (let i = 0; i < 1200; i++)
      add(db, String(i), i % 2 ? 'worker' : 'lead', i + 1, `instruction ${i}`);
    const initial = read(db);
    expect(JSON.stringify(initial).length).toBeLessThan(4300);
    db.function('cindy_authority_projection_v1', (_raw, _target, _previous, _event) => {
      throw new Error('unexpected replay');
    });
    for (let i = 0; i < 20; i++) expect(read(db)).toEqual(initial);
  });

  it('commits Lead and Worker changes together with both summaries and revision', () => {
    const db = open();
    add(db, 'l');
    const before = read(db);
    add(db, 'w', 'worker', 2, 'never publish');
    const row = stored(db);
    expect(row.projected_revision).toBe(row.revision);
    expect(row.revision).toBeGreaterThan(before.revision);
    expect(JSON.parse(row.payload)).toMatchObject({
      sessionIntent: 'never publish',
      reviewIntent: { earlierUserMessages: ['read only'], currentUserMessage: 'never publish' },
    });
    const checkpoint = read(db);
    expect(() =>
      db.transaction(() => {
        add(db, 'rollback', 'lead', 3, 'publish');
        throw new Error('abort');
      })(),
    ).toThrow('abort');
    expect(read(db)).toEqual(checkpoint);
    expect(db.prepare("SELECT 1 FROM messages WHERE id='rollback'").get()).toBeUndefined();
  });

  it('rolls back the message when projection computation fails', () => {
    const db = open();
    read(db);
    const before = stored(db);
    db.function('cindy_authority_projection_v1', (_raw, _target, _previous, _event) => {
      throw new Error('projection failed');
    });
    expect(() => add(db, 'bad')).toThrow('projection failed');
    expect(stored(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM messages').all()).toHaveLength(0);
  });

  it('moves an answered card to acceptance time and preserves ambiguous same-time rejection', () => {
    const db = open();
    add(db, 'q', 'worker', 1, 'question', 'ask_user', {});
    add(db, 'w', 'worker', 2, 'deny');
    read(db);
    db.prepare('UPDATE messages SET agent_meta=? WHERE id=?').run(
      JSON.stringify({ autoReviewUserText: { text: 'Clarifications:\nyes', acceptedAt: 3 } }),
      'q',
    );
    expect(read(db).sessionIntent).toEqual({
      earlierUserMessages: ['deny'],
      currentUserMessage: 'Clarifications:\nyes',
    });
    add(db, 'tie', 'worker', 3, '');
    expect(read(db).sessionIntent).toBe('');
    expect(read(db).reviewIntent).toMatchObject({ historyOmitted: true });
  });

  it('rebuilds clear, rewind, receipt removal, delete and attachment reset from current evidence', () => {
    const db = open();
    add(db, 'l', 'lead', 1, 'lead restriction');
    add(db, 'w', 'worker', 2, 'worker restriction');
    read(db);
    db.prepare('UPDATE sessions SET cleared_at=1 WHERE id=?').run('lead');
    expect(read(db).reviewIntent).toBe('worker restriction');
    add(db, 'attachment', 'worker', 3, 'new resource');
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(
      JSON.stringify({ text: 'new resource', files: [{}] }),
      'attachment',
    );
    expect(read(db).sessionIntent).toBe('new resource');
    db.prepare('UPDATE messages SET rewind_at=4 WHERE id=?').run('attachment');
    expect(read(db).sessionIntent).toBe('worker restriction');
    db.prepare('UPDATE messages SET agent_meta=? WHERE id=?').run('{}', 'w');
    expect(read(db).sessionIntent).toBe('');
    expect(read(db).reviewIntent).toMatchObject({ historyOmitted: true });
    db.prepare('DELETE FROM messages WHERE id=?').run('w');
    expect(read(db).reviewIntent).toBe('');
  });

  it('keeps continuations from resetting authorization and invalidates revisions even for repeated text', () => {
    const db = open();
    add(db, 'w', 'worker');
    const before = read(db);
    add(db, 'continued', 'worker', 2, '', 'user', {
      autoReviewUserText: { kind: 'delegated-continuation' },
    });
    expect(read(db).sessionIntent).toBe(before.sessionIntent);
    add(db, 'reset', 'worker', 3, '');
    expect(read(db).sessionIntent).toBe('');
    add(db, 'again', 'worker', 4);
    expect(read(db).sessionIntent).toBe(before.sessionIntent);
    expect(read(db).revision).toBeGreaterThan(before.revision);
  });

  it('recovers after another connection invalidates the persisted projection; cannot return old grants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-authority-'));
    directories.push(dir);
    const filename = path.join(dir, 'test.sqlite');
    const db = open(filename);
    add(db, 'w', 'worker', 1, 'allow');
    read(db);
    const legacy = open(filename, false);
    add(legacy, 'deny', 'worker', 2, 'deny');
    expect(stored(legacy).revision).not.toBe(stored(legacy).projected_revision);
    const restarted = open(filename, false);
    expect(read(restarted).sessionIntent).toEqual({
      earlierUserMessages: ['allow'],
      currentUserMessage: 'deny',
    });
    expect(stored(restarted).revision).toBe(stored(restarted).projected_revision);
  });

  it('rebuilds an empty malformed summary from current evidence', () => {
    const db = open();
    read(db);
    db.prepare("UPDATE auto_review_projections SET payload='{}'").run();
    expect(read(db)).toMatchObject({ sessionIntent: '', reviewIntent: '' });
  });

  it('runs the identical factory in the inline worker without Main imports', () => {
    const db = open();
    add(db, 'w', 'worker');
    const inline = new Function(
      `return (${readAutoReviewProjection.toString()})`,
    )() as typeof readAutoReviewProjection;
    const factory = new Function(
      `return (${createAutoReviewIntentProjection.toString()})`,
    )() as typeof createAutoReviewIntentProjection;
    expect(inline(db, { sessionId: 'worker', leadId: 'lead' }, factory).sessionIntent).toBe(
      'read only',
    );
    db.prepare("UPDATE auto_review_projections SET payload='{}'").run();
    add(db, 'restriction', 'worker', 2, 'never publish');
    expect(JSON.stringify(inline(db, { sessionId: 'worker', leadId: 'lead' }, factory).reviewIntent)).toContain('never publish');
  });
});
