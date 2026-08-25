import { afterEach, describe, expect, it } from 'vitest';

import {
  bumpSessionListWriteGeneration,
  noteSessionListDbWrite,
  readSessionListWriteGeneration,
  resetSessionListWriteGenerationForTests,
  sqlAffectsSessionListProjection,
} from '../sessionListWriteGeneration';

afterEach(() => {
  resetSessionListWriteGenerationForTests();
});

describe('sqlAffectsSessionListProjection', () => {
  it('matches sessions and messages DML', () => {
    expect(sqlAffectsSessionListProjection('INSERT INTO sessions (id) VALUES (?)')).toBe(true);
    expect(sqlAffectsSessionListProjection('insert into "sessions" ("id") values (?)')).toBe(true);
    expect(sqlAffectsSessionListProjection('UPDATE sessions SET title = ?')).toBe(true);
    expect(sqlAffectsSessionListProjection('DELETE FROM messages WHERE id = ?')).toBe(true);
  });

  it('ignores reads and other tables', () => {
    expect(sqlAffectsSessionListProjection('SELECT * FROM sessions')).toBe(false);
    expect(sqlAffectsSessionListProjection('INSERT INTO recent_workdirs (path) VALUES (?)')).toBe(
      false,
    );
    expect(sqlAffectsSessionListProjection('UPDATE hook_group_messages SET text = ?')).toBe(false);
  });
});

describe('noteSessionListDbWrite', () => {
  it('bumps for import, message, and session txs but not unrelated ones', () => {
    expect(readSessionListWriteGeneration()).toBe(0);
    noteSessionListDbWrite({ txName: 'wechatLeaseNextTask' });
    expect(readSessionListWriteGeneration()).toBe(0);
    noteSessionListDbWrite({ txName: 'embedding.enqueue' });
    expect(readSessionListWriteGeneration()).toBe(0);
    noteSessionListDbWrite({ txName: 'message.delete' });
    expect(readSessionListWriteGeneration()).toBe(1);
    noteSessionListDbWrite({ txName: 'session.importShare' });
    expect(readSessionListWriteGeneration()).toBe(2);
    noteSessionListDbWrite({ txName: 'codex.importMessages' });
    expect(readSessionListWriteGeneration()).toBe(3);
  });

  it('bumps for sessions insert SQL used by CLI import', () => {
    noteSessionListDbWrite({
      sql: `
    INSERT INTO sessions (
      id, title
    )
    VALUES (?, ?)`,
    });
    expect(readSessionListWriteGeneration()).toBe(1);
  });
});

describe('bumpSessionListWriteGeneration', () => {
  it('advances the counter', () => {
    bumpSessionListWriteGeneration();
    expect(readSessionListWriteGeneration()).toBe(1);
  });
});
