import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsWebTransport, type SettingsWebContext } from '../webTransport.js';
import { settingsWebCommandSchema, settingsWebResultSchema } from '../../../shared/settingsWeb.js';
import { normalizeHostSettingsChange } from '../../../shared/hostSettings.js';

const context = (): SettingsWebContext => ({ scopeKey: 'example-owner:1:example-device', baseUrl: 'https://cloud.example.invalid/prefix', accessToken: 'invalid-fixture-token' });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const command = () => ({ kind: 'update' as const, change: { domain: 'databaseWarning' as const, expectedRevision: 'read-before', operationId: randomUUID(), set: { thresholdGiB: 5 } } });
function fixture(options: { expires?: number; wrongRuntime?: boolean; failAck?: boolean; hostCalls?: boolean; clock?: () => number } = {}) {
  let state: SettingsWebContext | null = context(); let registered = ''; let polls = 0; let ack = 0;
  const now = Date.now(), requestId = randomUUID(), input = command();
  const execute = vi.fn(async (_input: unknown, assertCurrent: () => void) => { assertCurrent(); return { ok: true as const, receipt: { status: 'saved' as const, saved: true, application: 'applied' as const, operationId: input.change.operationId, domain: 'databaseWarning' as const, revision: 'read-after' } }; });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/connect')) { registered = JSON.parse(String(init?.body)).runtimeId; return reply({ ok: true }); }
    if (String(url).endsWith('/poll')) return reply({ request: polls++ ? null : { requestId, runtimeId: options.wrongRuntime ? randomUUID() : registered, sessionKey: 'a'.repeat(64), expiresAtMs: options.expires ?? now + 30_000, command: input } });
    if (String(url).endsWith('/result')) { ack += 1; if (options.failAck && ack === 1) throw new Error('lost acknowledgement'); return reply({ ok: true }); }
    throw new Error('unexpected URL');
  });
  const transport = createSettingsWebTransport({ getContext: () => state, fetch, execute, now: options.clock ?? (() => now),
    ...(options.hostCalls ? { managementV1: true, hostCalls: { channels: ['cloud:storage-usage:v1'], desktopV1: true as const } } : {}) });
  return { transport, fetch, execute, now, changeContext(value: SettingsWebContext | null) { state = value; } };
}
describe('web settings Host transport', () => {
  it('advertises batch reads and registers in legacy mode only if old CIS rejects the new field', async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).readBatch).toBe(true);
      return reply({error:{code:'INVALID_PARAMS'}},400);
    });
    await f.transport.runOnce();
    const connects = f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/connect'));
    expect(connects).toHaveLength(2);
    expect(JSON.parse(String(connects[1]![1]?.body))).not.toHaveProperty('readBatch');
    expect(f.execute).toHaveBeenCalledTimes(1); f.transport.stop();
  });
  it('declares browser Host calls first and drops only them when an older CIS rejects the fields', async () => {
    const f = fixture({ hostCalls: true });
    f.fetch.mockImplementationOnce(async () => reply({ error: { code: 'INVALID_PARAMS' } }, 400));
    await f.transport.runOnce();
    const bodies = f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/connect')).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ readBatch: true, managementV1: true, channels: ['cloud:storage-usage:v1'], desktopV1: true });
    expect(bodies[1]).toMatchObject({ readBatch: true, managementV1: true });
    expect(bodies[1]).not.toHaveProperty('channels'); expect(bodies[1]).not.toHaveProperty('desktopV1');
    expect(f.execute).toHaveBeenCalledTimes(1); f.transport.stop();
  });
  it('polls again at once after a held poll, but backs off after an immediate empty reply', async () => {
    let clock = Date.now();
    const f = fixture({ clock: () => clock });
    await f.transport.runOnce();
    f.fetch.mockImplementationOnce(async () => { clock += 6_000; return reply({ request: null }); });
    expect(await f.transport.runOnce()).toBe(50);
    expect(await f.transport.runOnce()).toBe(2_000); f.transport.stop();
  });
  it('does not downgrade capability registration on authentication failure', async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(reply({},401));
    await f.transport.runOnce(); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled(); f.transport.stop();
  });
  it('uses only the configured HTTPS endpoint and authenticated, bounded commands', async () => {
    const f = fixture(); await f.transport.runOnce();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledWith('https://cloud.example.invalid/prefix/instances/self/settings/connect', expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }));
    await f.transport.runOnce(); expect(f.execute).toHaveBeenCalledTimes(1);
    f.transport.stop();
  });
  it('retries only the receipt when its acknowledgement is lost', async () => {
    const f = fixture({ failAck: true }); await f.transport.runOnce();
    expect(f.execute).toHaveBeenCalledTimes(1);
    const results = f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/result'));
    expect(results).toHaveLength(2); expect(results[0]![1]?.body).toBe(results[1]![1]?.body); f.transport.stop();
  });
  it.each([{ expires: 1 }, { expires: Number.MAX_SAFE_INTEGER }, { wrongRuntime: true }])('does not run expired or wrong-process requests %j', async options => {
    const f = fixture(options); await f.transport.runOnce(); expect(f.execute).not.toHaveBeenCalled(); f.transport.stop();
  });
  it('revalidates identity at the actual writer boundary and drops delivery after an owner change', async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async (_request, assertCurrent) => {
      f.changeContext({ ...context(), scopeKey: 'other-owner:2' }); expect(assertCurrent).toThrow(); throw new Error('owner changed');
    });
    await f.transport.runOnce(); expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/result'))).toHaveLength(0); f.transport.stop();
  });
  it.each(['http://cloud.example.invalid', 'https://user:pass@cloud.example.invalid', 'https://cloud.example.invalid/?token=bad'])('does not send credentials to an invalid endpoint %s', async baseUrl => {
    const f = fixture(); f.changeContext({ ...context(), baseUrl }); await f.transport.runOnce(); expect(f.fetch).not.toHaveBeenCalled(); f.transport.stop();
  });
  it('does nothing without committed cloud identity or after stopping', async () => {
    const f = fixture(); f.changeContext(null); await f.transport.runOnce(); expect(f.fetch).not.toHaveBeenCalled();
    f.changeContext(context()); f.transport.stop(); await f.transport.runOnce(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('accepts explicit automatic effort without turning it into a default override', () => {
    const change = { domain: 'newTaskDefaults', operationId: randomUUID(), expectedRevision: 'before', set: { effort: null } };
    expect(settingsWebCommandSchema.parse({ kind: 'update', change })).toMatchObject({ change: { set: { effort: null } } });
    expect(normalizeHostSettingsChange({ domain: change.domain, set: change.set })).toMatchObject({ set: { effort: null }, clear: [] });
  });
  it('rejects an oversized response and raw prompt disclosure', () => {
    expect(settingsWebResultSchema.safeParse({ ok: true, userPrompt: 'private' }).success).toBe(false);
    expect(settingsWebCommandSchema.safeParse({ kind: 'read', domain: 'personalization', includeUserPrompt: true }).success).toBe(false);
  });
});
