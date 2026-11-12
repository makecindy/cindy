import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { countMediaInvocations, getMediaInvocation, pruneMediaInvocations } from '../mediaInvocationStore.js';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));

describe('saved generation responses', () => {
  it('reads old and new paid-task snapshots without rewriting the stored protocol or binding', async () => {
    const raw = new Database(':memory:');
    try {
      raw.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0092_fixed_zeigeist.sql'), 'utf8'));
      const operation = {
        capability: 'video.generate',
        request: { method: 'POST', path: '/videos/generations', bodyModelPath: ['model'], timeoutMs: 1_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 },
        response: { mode: 'async', taskIdPath: ['request_id'], poll: {
          method: 'GET', path: '/videos/{taskId}', statusPath: ['status'], successValues: ['done'], failureValues: ['failed'],
          recommendedIntervalMs: 1_000, timeoutMs: 1_000, maxResponseBytes: 1_024,
          media: [{ path: ['video', 'url'], encoding: 'url', kind: 'video', allowedUrlHosts: ['vidgen.x.ai'] }],
        } },
        instructions: '轮询原任务', exampleBody: { prompt: 'cat' }, inputSchema: { type: 'object' }, officialDocs: 'https://example.com/videos',
      };
      const binding = { providerId: 'relay', executor: 'provider-video', connectionRevision: '1:original' };
      const snapshots = [
        { guideId: 'cindy-provider-xai-video-v1', revision: '1:original', connection: { providerId: 'relay' } },
        { guideId: 'opaque-server-id', revision: 'server-revision', binding },
      ];
      const db = { queryOne: async (sql: string, args: unknown[]) => raw.prepare(sql).get(...args) } as unknown as DbClient;
      for (const [index, snapshot] of snapshots.entries()) {
        const id = `paid-${index}`;
        const json = JSON.stringify({ schemaVersion: 1, modelId: 'private-video', ...operation, ...snapshot });
        raw.prepare(`INSERT INTO media_invocations
          (id, owner, model_id, capability, guide_revision, guide_json, state, task_id, created_at, updated_at)
          VALUES (?, 'owner', 'private-video', 'video.generate', ?, ?, 'pending', 'original-task', 1, 1)`)
          .run(id, snapshot.revision, json);
        expect(await getMediaInvocation(id, 'owner', db)).toMatchObject({
          state: 'pending', taskId: 'original-task', guideRevision: snapshot.revision,
          guide: { revision: snapshot.revision, binding },
        });
        expect(raw.prepare('SELECT guide_json FROM media_invocations WHERE id = ?').get(id)).toEqual({ guide_json: json });
      }
    } finally { raw.close(); }
  });

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
