import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { countMediaInvocations, pruneMediaInvocations } from '../mediaInvocationStore.js';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));

describe('saved generation responses', () => {
  it('keeps undownloaded results across pruning without exhausting generation slots', async () => {
    const raw = new Database(':memory:');
    try {
      raw.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0092_fixed_zeigeist.sql'), 'utf8'));
      const insert = raw.prepare(`INSERT INTO media_invocations
        (id, owner, model_id, capability, guide_revision, guide_json, state, response_json, created_at, updated_at)
        VALUES (?, ?, 'model', 'image.generate', 'v1', '{}', ?, ?, 1, 1)`);
      insert.run('saved', 'owner', 'pending', '{"data":"saved-response"}');
      insert.run('running', 'owner', 'pending', null);
      insert.run('prepared', 'owner', 'prepared', null);
      insert.run('complete', 'owner', 'complete', '{}');
      insert.run('other-owner', 'other', 'pending', null);
      const db = {
        exec: async (sql: string, args: unknown[]) => raw.prepare(sql).run(...args),
        queryOne: async (sql: string, args: unknown[]) => raw.prepare(sql).get(...args),
      } as unknown as DbClient;
      expect(await countMediaInvocations('owner', db)).toBe(2);
      await pruneMediaInvocations({ owner: 'owner', preparedBefore: 2, terminalBefore: 2 }, db);
      expect(raw.prepare('SELECT id FROM media_invocations ORDER BY id').all()).toEqual([
        { id: 'other-owner' }, { id: 'saved' },
      ]);
    } finally { raw.close(); }
  });
});
