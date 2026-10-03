import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createXaiVideoProvider } from '../../cindy-proxy-media/video/providers/xai.js';
import { configureProviderMediaRuntime } from '../providerMediaRuntime.js';
import { providerVideoGuide } from '../providerVideoGuide.js';
import { submitProviderVideo, pollProviderVideo, type ProviderVideoContext } from '../providerVideoInvocation.js';
import { createMediaInvocation, getMediaInvocation, transitionMediaInvocation } from '../mediaInvocationStore.js';
import { downloadMediaResult } from '../mediaDownload.js';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
const transport = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../../maker-host/outbound-fetch.js', () => ({
  guardedOutboundFetch: async (url: string, init: RequestInit, gate: () => void) => {
    gate();
    return { response: await transport.download(url, init), release: async () => {} };
  },
}));

describe('native video response recovery with real SQLite persistence', () => {
  let dir: string;
  let raw: Database.Database;
  let db: DbClient;
  let providerFetch: ReturnType<typeof vi.fn>;
  let ctx: ProviderVideoContext;
  let rejectResponseWrite: boolean;
  let epoch: number;
  const oldUrl = 'https://vidgen.x.ai/old.mp4';
  const freshUrl = 'https://vidgen.x.ai/fresh.mp4';
  const row = async () => (await getMediaInvocation('video', 'owner', db))!;
  const source = (responseJson: string | undefined) => new URL(JSON.parse(responseJson!).videoUrl).searchParams.get('source');
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-video-recovery-'));
    raw = new Database(path.join(dir, 'tasks.sqlite'));
    rejectResponseWrite = false;
    epoch = 1;
    raw.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0092_fixed_zeigeist.sql'), 'utf8'));
    db = {
      exec: async (sql: string, args: unknown[]) => {
        if (rejectResponseWrite && sql.includes('response_json = ?')) throw new Error('offline write failure');
        return raw.prepare(sql).run(...args);
      },
      queryOne: async (sql: string, args: unknown[]) => raw.prepare(sql).get(...args),
    } as unknown as DbClient;
    providerFetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      init.method === 'POST' ? { request_id: 'original-task' } : { status: 'done', video: { url: freshUrl } },
    )));
    const provider = createXaiVideoProvider({
      hasOAuthLogin: () => true, getAccessToken: async () => 'offline-test-token',
      getCredentialGeneration: () => epoch, getCredentialSessionId: () => 'test-login',
      getOwnerScopeKey: () => 'owner:1', isOwnerBoundaryPending: () => false,
      fetchImplementation: providerFetch as typeof fetch,
    });
    const model = { id: 'xai/grok-imagine-video', name: 'Video', providerId: 'xai',
      mode: 'video_generation' as const, modalities: { input: ['text', 'image'], output: ['video'] } };
    configureProviderMediaRuntime({ listModels: () => [], listVideoModels: () => [model],
      resolveVideo: () => provider, invoke: async () => { throw new Error('unexpected image dispatch'); } });
    ctx = {
      db, assertActive: vi.fn(), resolveImage: async () => { throw new Error('no reference needed'); },
      materialize: vi.fn(async (url, allowedHosts, assertActive, providerDownload) => {
        // Actual downloader including its retries; only external HTTP is faked.
        const result = await downloadMediaResult({ raw: url, allowedHosts, assertActive, providerDownload });
        await result.dispose();
        return { xdt_video_urls: ['cindy-media://blobs/test.mp4'] };
      }),
      complete: vi.fn(async (invocation, media) => {
        await transitionMediaInvocation({ id: invocation.id, owner: invocation.owner,
          from: 'pending', to: 'complete', responseJson: JSON.stringify(media) }, db);
        return { ok: true, status: 'complete' };
      }),
      completed: vi.fn(() => ({ ok: true, status: 'complete' })),
    };
    await createMediaInvocation({ id: 'video', owner: 'owner', createdAt: Date.now(),
      guide: providerVideoGuide(model, 'video.generate', provider) }, db);
    await submitProviderVideo(await row(), { prompt: 'offline recovery test' }, ctx);
    // Seed a genuine Provider success reference, with the old address.
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'done', video: { url: oldUrl } })));
    transport.download.mockReset().mockImplementation(async () => new Response('', { status: 403 }));
    await pollProviderVideo(await row(), ctx);
    vi.mocked(ctx.materialize).mockClear();
  });
  afterEach(() => { raw.close(); rmSync(dir, { recursive: true, force: true }); });

  it.each([401, 403, 404, 410])('saves refreshed success before delivery and resumes after SQLite reopen (old HTTP %i)', async (httpStatus) => {
    const original = await row();
    transport.download.mockImplementation(async (url: string) => {
      if (url === oldUrl) return new Response('', { status: httpStatus });
      // This assertion reads SQLite, not a retained invocation object.
      expect(source((await row()).responseJson)).toBe(freshUrl);
      throw Object.assign(new Error('offline transient failure'), { code: 'ECONNRESET' });
    });
    expect(await pollProviderVideo(original, ctx)).toMatchObject({ errorCode: 'MEDIA_DOWNLOAD_FAILED', result_retained: true });
    expect(source((await row()).responseJson)).toBe(freshUrl);
    expect((await row()).taskId).toBe(original.taskId);
    raw.close(); raw = new Database(path.join(dir, 'tasks.sqlite'));
    const restored = await row();
    // A redundant upstream GET would now lose access, though the new CDN URL still works.
    providerFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'expired' })));
    const reads = providerFetch.mock.calls.length;
    transport.download.mockReset().mockImplementation(async (url: string) => {
      expect(url).toBe(freshUrl);
      return new Response('offline-video-bytes');
    });
    expect(await pollProviderVideo(restored, { ...ctx })).toMatchObject({ status: 'complete' });
    expect(providerFetch.mock.calls.length).toBe(reads);
    expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(transport.download).toHaveBeenCalledTimes(1);
  });

  it('does not download the refreshed result when persistence fails, retaining the previous success', async () => {
    const original = await row();
    rejectResponseWrite = true;
    expect(await pollProviderVideo(original, ctx)).toMatchObject({ errorCode: 'MEDIA_RESPONSE_SAVE_FAILED',
      result_retained: true, retryable: true, delivery_error: { stage: 'ledger' } });
    expect((await row()).responseJson).toBe(original.responseJson);
    expect(vi.mocked(ctx.materialize).mock.calls.map(([url]) => url)).toEqual([oldUrl]);
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it.each(['complete', 'newer-response'])('does not overwrite a concurrent %s while refreshing', async (race) => {
    const original = await row();
    const newer = race === 'complete' ? '{"xdt_video_urls":["cindy-media://blobs/already.mp4"]}'
      : JSON.stringify({ ...JSON.parse(original.responseJson!), meta: { revision: 'newer' } });
    providerFetch.mockImplementationOnce(async () => {
      raw.prepare('UPDATE media_invocations SET state = ?, response_json = ? WHERE id = ?')
        .run(race === 'complete' ? 'complete' : 'pending', newer, 'video');
      return new Response(JSON.stringify({ status: 'done', video: { url: freshUrl } }));
    });
    expect(await pollProviderVideo(original, ctx)).toMatchObject(race === 'complete'
      ? { status: 'complete' } : { errorCode: 'INVOCATION_STATE_CHANGED', retryable: true });
    expect((await row()).responseJson).toBe(newer);
    expect(vi.mocked(ctx.materialize).mock.calls.map(([url]) => url)).toEqual([oldUrl]);
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it('rejects an account epoch change during refresh before saving or delivering the new reference', async () => {
    const original = await row();
    providerFetch.mockImplementationOnce(async () => {
      epoch++;
      return new Response(JSON.stringify({ status: 'done', video: { url: freshUrl } }));
    });
    await expect(pollProviderVideo(original, ctx)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect((await row()).responseJson).toBe(original.responseJson);
    expect(vi.mocked(ctx.materialize).mock.calls.map(([url]) => url)).toEqual([oldUrl]);
  });

  it('retains the previous success when the Provider rejects an untrusted refreshed URL', async () => {
    const original = await row();
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'done', video: { url: 'https://untrusted.invalid/video.mp4' } })));
    expect(await pollProviderVideo(original, ctx)).toMatchObject({ ok: false });
    expect((await row()).responseJson).toBe(original.responseJson);
    expect(vi.mocked(ctx.materialize).mock.calls.map(([url]) => url)).toEqual([oldUrl]);
  });
});
