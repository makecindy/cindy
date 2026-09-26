import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { countMediaInvocations, pruneMediaInvocations, createMediaInvocation, getMediaInvocation, transitionMediaInvocation, recoverInterruptedMediaInvocations } from '../mediaInvocationStore.js';
import { providerVideoGuide, encodeVideoHandle } from '../providerVideoGuide.js';
import { createXaiVideoProvider } from '../../cindy-proxy-media/video/providers/xai.js';
import { parseResolvedMediaInvocationGuide } from '../../../shared/mediaInvocation.js';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));

describe('saved generation responses', () => {
  it('round-trips native video guide and handle through SQLite reopen; submitting recovers to unknown', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-video-store-'));
    let raw = new Database(path.join(dir, 'tasks.sqlite'));
    const db = {
      exec: async (sql: string, args: unknown[]) => raw.prepare(sql).run(...args),
      queryOne: async (sql: string, args: unknown[]) => raw.prepare(sql).get(...args),
    } as unknown as DbClient;
    try {
      raw.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0092_fixed_zeigeist.sql'), 'utf8'));
      const provider = createXaiVideoProvider({ hasOAuthLogin: () => true,
        getAccessToken: async () => { throw new Error('offline test: no network'); },
        getOwnerScopeKey: () => 'test-owner:1', getCredentialGeneration: () => 1,
        getCredentialSessionId: () => 'fake-login-nonce', isOwnerBoundaryPending: () => false });
      const guide = providerVideoGuide({ id: 'xai/grok-imagine-video', providerId: 'xai', name: 'video',
        mode: 'video_generation', modalities: { input: ['text', 'image'], output: ['video'] } }, 'video.generate', provider);
      // A Gateway response cannot inject the Host-only dispatch mode.
      const { modelId, capability, request, response, instructions, exampleBody, inputSchema, officialDocs, ...protocol } = guide;
      expect(parseResolvedMediaInvocationGuide({ modelId, guide: { ...protocol,
        operations: [{ capability, request, response, instructions, exampleBody, inputSchema, officialDocs }] } }).ok).toBe(false);
      await createMediaInvocation({ id: 'video', owner: 'owner', guide, createdAt: Date.now() }, db);
      expect(await transitionMediaInvocation({ id: 'video', owner: 'wrong-owner', from: 'prepared', to: 'submitting' }, db)).toBe(false);
      const claim = { id: 'video', owner: 'owner', from: 'prepared' as const, to: 'submitting' as const };
      expect(await Promise.all([transitionMediaInvocation(claim, db), transitionMediaInvocation(claim, db)])).toEqual([true, false]);
      const taskId = encodeVideoHandle({ taskId: 'remote-1', providerId: provider.id, modelUsed: 'grok-imagine-video',
        submittedAt: Date.now(), ownerScopeKey: 'test-owner:1', credentialGeneration: 1 }, guide);
      await transitionMediaInvocation({ ...claim, from: 'submitting', to: 'pending', taskId }, db);
      await createMediaInvocation({ id: 'interrupted', owner: 'owner', guide, createdAt: Date.now() }, db);
      await transitionMediaInvocation({ ...claim, id: 'interrupted' }, db);
      raw.close(); raw = new Database(path.join(dir, 'tasks.sqlite'));
      expect(await recoverInterruptedMediaInvocations('owner', db)).toBe(1);
      expect(await getMediaInvocation('video', 'owner', db)).toMatchObject({ state: 'pending', taskId, guide });
      expect(await getMediaInvocation('interrupted', 'owner', db)).toMatchObject({ state: 'unknown' });
      expect(await getMediaInvocation('video', 'other-owner', db)).toBeNull();
    } finally { raw.close(); rmSync(dir, { recursive: true, force: true }); }
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
