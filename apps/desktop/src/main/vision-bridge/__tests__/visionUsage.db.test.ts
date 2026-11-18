/** Regression: independent vision requests must reach the real auxiliary ledger once per dispatch. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { waitForRetainedDbClient } from '../../localDb/client/pendingOperations.js';
import { getModelUsageSince } from '../../localDb/dailyModelUsage.js';
import { describeImageWithProvider, type VisionChannelDeps } from '../vision-channel.js';
import { createVisionBridge } from '../visionBridgeCore.js';
import { createPiVisionUsageRecorder } from '../piVisionUsage.js';

const databases: Database.Database[] = [];
function owner(id = 'owner') {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE auxiliary_usage_receipts (receipt_id TEXT PRIMARY KEY, provider_id TEXT, model TEXT,
    source TEXT, session_id TEXT, transport TEXT, day TEXT, recorded_at INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
  db.exec(`CREATE TABLE daily_model_usage (day TEXT, agent_kind TEXT, model TEXT, cost_usd REAL,
    cost_amount REAL, cost_currency TEXT, cost_is_approximate INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
  const client = { drizzle: drizzle(db), query: async (sql: string, params: unknown[]) => db.prepare(sql).all(...params) } as unknown as DbClient;
  setCurrentDbClient(client, id);
  return { db, client };
}
const input = { imageUrl: 'data:image/png;base64,fixture', prompt: 'describe', sessionId: 'task' };
const usage = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 2 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deps(wire = 'openai-chat', fetcher: typeof fetch = vi.fn(async () => response({ model: 'served', usage, choices: [{ message: { content: 'description' } }] }))) {
  return { getProviderById: () => null,
    resolveBackendRoute: (provider: string) => ({ upstream: 'https://fixture.invalid', requestPath: '/' + provider,
      model: 'routed', authorization: null, headers: {}, wireProtocol: wire }), fetch: fetcher,
  } as VisionChannelDeps;
}
type Receipt = { provider_id: string; model: string; source: string; session_id: string; input_tokens: number | null; cache_read_tokens: number | null; output_tokens: number | null };
const rows = (db: Database.Database) => db.prepare('SELECT provider_id,model,source,session_id,input_tokens,cache_read_tokens,output_tokens FROM auxiliary_usage_receipts ORDER BY rowid').all() as Receipt[];
afterEach(() => { clearCurrentDbClient(); for (const db of databases.splice(0)) db.close(); });

describe('vision accounting', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic-messages'])('normalizes %s and records the served model and task', async wire => {
    const { db } = owner();
    const body = wire === 'openai-chat' ? { model: 'served', usage, choices: [{ message: { content: 'description' } }] }
      : wire === 'openai-responses' ? { model: 'served', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 2 }, output: [{ type: 'output_text', text: 'description' }] }
      : { model: 'served', usage: { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 2 }, content: [{ type: 'text', text: 'description' }] };
    expect(await describeImageWithProvider('provider', 'alias', input, deps(wire, vi.fn(async () => response(body))))).toBe('description');
    expect(rows(db)).toEqual([{ provider_id: 'provider', model: 'served', source: 'vision-bridge', session_id: 'task', input_tokens: 60, cache_read_tokens: 40, output_tokens: 2 }]);
  });

  it.each(['empty', 'http'])('keeps the %s primary usage, meters fallback, and does not charge cache/in-flight hits', async failure => {
    const { db } = owner();
    const fetcher = vi.fn(async (url: unknown) => response({ model: String(url).endsWith('/primary') ? 'actual-primary' : 'actual-fallback', usage,
      choices: [{ message: { content: String(url).endsWith('/primary') ? '' : 'description' } }] }, failure === 'http' && String(url).endsWith('/primary') ? 502 : 200));
    const bridge = createVisionBridge(deps('openai-chat', fetcher), {
      readVisionBridgeSettings: () => ({ enabled: true, targetModels: [], primary: { providerId: 'primary', modelId: 'alias' }, fallback: { providerId: 'fallback', modelId: 'alias' } }),
      isTargetModelsCustomized: () => true,
    });
    try {
      expect(await Promise.all([bridge.describeImage(input), bridge.describeImage(input)])).toEqual(['description', 'description']);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(rows(db).map(r => [r.provider_id, r.model, r.input_tokens, r.cache_read_tokens, r.output_tokens])).toEqual([
        ['primary', 'actual-primary', 60, 40, 2], ['fallback', 'actual-fallback', 60, 40, 2],
      ]);
      expect(rows(db).every(r => r.session_id === 'task')).toBe(true);
      // Existing routing retries primary; only the fallback cache avoids a dispatch.
      expect(await bridge.describeImage(input)).toBe('description');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(rows(db)).toHaveLength(3);
      expect(rows(db)[2].provider_id).toBe('primary');
    } finally { bridge.dispose(); }
  });

  it('does not charge a successful primary cache hit or a shared in-flight waiter', async () => {
    const { db } = owner(); const d = deps();
    const bridge = createVisionBridge(d, {
      readVisionBridgeSettings: () => ({ enabled: true, targetModels: [], primary: { providerId: 'primary', modelId: 'alias' }, fallback: null }),
      isTargetModelsCustomized: () => true,
    });
    try {
      await Promise.all([bridge.describeImage(input), bridge.describeImage(input)]);
      await bridge.describeImage(input);
      expect(d.fetch).toHaveBeenCalledTimes(1); expect(rows(db)).toHaveLength(1);
    } finally { bridge.dispose(); }
  });

  it('does not invent usage for missing/malformed/cancelled responses but preserves explicit zero', async () => {
    const { db } = owner();
    const body = { choices: [{ message: { content: 'description' } }] };
    await describeImageWithProvider('p', 'm', input, deps('openai-chat', vi.fn(async () => response(body))));
    await describeImageWithProvider('p', 'm', input, deps('openai-chat', vi.fn(async () => response({ ...body, usage: { prompt_tokens: 0, completion_tokens: 0 } }))));
    await expect(describeImageWithProvider('p', 'm', { ...input, signal: AbortSignal.abort() }, deps())).rejects.toMatchObject({ code: 'abort' });
    await expect(describeImageWithProvider('p', 'm', input, deps('openai-chat', vi.fn(async () => new Response('broken'))))).rejects.toMatchObject({ code: 'http' });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ input_tokens: 0, output_tokens: 0, cache_read_tokens: null });
  });

  it('writes a late vision response to the account captured before the request', async () => {
    const first = owner('first'); let resolve!: (value: Response) => void;
    const pending = describeImageWithProvider('p', 'm', input, deps('openai-chat', vi.fn(() => new Promise<Response>(r => { resolve = r; }))));
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const second = owner('second');
    resolve(response({ model: 'served', usage, choices: [{ message: { content: 'description' } }] }));
    await pending;
    expect(rows(first.db)).toHaveLength(1); expect(rows(second.db)).toHaveLength(0);
  });

  it('binds private Pi facts to trusted backends and original owner, deduplicates retries, and closes cleanly', async () => {
    const first = owner('first');
    const backend = (providerId: string) => ({ providerId, model: 'alias', wireProtocol: 'openai-chat', baseUrl: 'https://fixture.invalid', requestPath: '/v1', authorization: null, headers: {} });
    const recorder = createPiVisionUsageRecorder({ CINDY_PI_VISION_BRIDGE: JSON.stringify({ enabled: true, primary: backend('primary'), fallback: backend('fallback') }) }, 'task');
    const second = owner('second');
    const packet = { requestId: '11111111-1111-4111-8111-111111111111', backendRole: 'primary', model: 'served', usage, providerId: 'forged', sessionId: 'forged' };
    await recorder.observe(packet); await recorder.observe(packet);
    await recorder.observe({ ...packet, requestId: '22222222-2222-4222-8222-222222222222', backendRole: 'fallback' });
    await recorder.observe({ ...packet, requestId: 'bad-id' });
    await recorder.observe({ ...packet, requestId: '33333333-3333-4333-8333-333333333333', backendRole: 'unknown' });
    await recorder.observe({ ...packet, requestId: '44444444-4444-4444-8444-444444444444', usage: {} });
    recorder.close(); await waitForRetainedDbClient(first.client);
    await recorder.observe({ ...packet, requestId: '55555555-5555-4555-8555-555555555555' });
    expect(rows(first.db)).toEqual(['primary', 'fallback'].map(provider_id => ({ provider_id, model: 'served', source: 'vision-bridge', session_id: 'task', input_tokens: 60, cache_read_tokens: 40, output_tokens: 2 })));
    expect(rows(second.db)).toHaveLength(0);
    setCurrentDbClient(first.client, 'first');
    const projected = await getModelUsageSince('0000-01-01');
    expect(projected.reduce((n, r) => n + (r.requestCount ?? 0), 0)).toBe(2);
    expect(projected.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheCreateTokens + r.outputTokens, 0)).toBe(204);
    expect(projected.every(r => r.agentKind === 'auxiliary' && r.source === 'vision-bridge')).toBe(true);
    expect(await getModelUsageSince('0000-01-01')).toEqual(projected);
    expect(rows(first.db)).toHaveLength(2);
  });
});
