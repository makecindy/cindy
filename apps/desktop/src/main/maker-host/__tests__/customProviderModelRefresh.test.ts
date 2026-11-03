import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUserProvider, type AgentKind, type CustomProviderConfig, type ProviderView } from '@cindy/model-providers';
import { createCustomProviderModelRefresh, createCustomProviderRefreshAttempts, CUSTOM_PROVIDER_REFRESH_INTERVAL as DAY } from '../custom-provider-model-refresh.js';
import type { ProviderModelsFetchResult } from '../provider-model-fetch.js';

// New Main-only background entry: previous page refresh tests cannot exercise persisted
// scheduling or account changes. Minimal failures: restart, manual reset, one pending request.
// Unit tier, injected network/clock; temporary storage contains only fake IDs and timestamps.
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  let time = 1793664000000;
  let owner = { dataOwnerId: 'owner-a', generation: 1 };
  let revision = 0;
  let mutating = false;
  let ready = true;
  const configs = new Map<string, CustomProviderConfig>([['example', { id: 'example', name: 'Example', runtimes: {
    'claude-code': { baseUrl: 'https://example.test', models: [] },
    codex: { baseUrl: 'https://example.test/v1', models: [] },
    pi: { baseUrl: 'https://example.test/v1', models: [] },
  } }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-provider-refresh-'));
  directories.push(dir);
  const file = () => path.join(dir, owner.dataOwnerId + '.json');
  const log = { info: vi.fn(), warn: vi.fn() };
  const makeStore = () => createCustomProviderRefreshAttempts({ filePath: file, scopeKey: () => JSON.stringify(owner), log });
  const fetch = vi.fn(async (): Promise<ProviderModelsFetchResult> => ({ ok: true, models: [{ id: 'new-model', name: 'New model' }] }));
  const apply = vi.fn(async (_id: string, _deltas: import('../../../shared/customProviderUpdate.js').CustomProviderDiscoveryDelta[]) => {});
  const view = (config: CustomProviderConfig): ProviderView => ({ ...buildUserProvider(config), connected: true });
  const read = vi.fn(async (id: string) => {
    const config = configs.get(id);
    return config ? { config, provider: view(config) } : null;
  });
  const credentials = vi.fn(() => ({ apiKey: 'FAKE-KEY' as string | null, headers: undefined as Record<string, string> | undefined }));
  const listIds = vi.fn(async () => [...configs.keys()]);
  const create = (attempts = makeStore()) => createCustomProviderModelRefresh({ owner: () => owner, ready: () => ready,
    listIds, read, revision: () => revision, mutating: () => mutating,
    credentials, fetch, apply, attempts, now: () => time });
  return { create, fetch, apply, configs, listIds, read, credentials, file, makeStore,
    setTime(value: number) { time = value; }, getTime: () => time,
    setOwner(value: typeof owner) { owner = value; }, bump() { revision++; },
    setMutating(value: boolean) { mutating = value; }, setReady(value: boolean) { ready = value; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('custom provider daily refresh', () => {
  it('refreshes all runtimes once per connection, persists attempts across restart and retries at exactly 24 hours', async () => {
    const f = fixture(); const service = f.create();
    f.fetch.mockResolvedValueOnce({ ok: false, code: 'UNKNOWN' });
    await Promise.all([service.run(), service.run()]);
    expect(f.fetch.mock.calls).toHaveLength(3);
    expect(f.apply.mock.calls[0][1].map((d: { snapshot: { agent: string } }) => d.snapshot.agent)).toEqual(['codex', 'pi']);
    expect(JSON.parse(fs.readFileSync(f.file(), 'utf8'))).toEqual({ version: 1, providers: { example: { lastAttemptAt: f.getTime() } } });
    f.setTime(f.getTime() + DAY - 1); await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(3);
    f.setTime(f.getTime() + 1); await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(6);
  });
  it.each([true, false])('manual query resets the full interval on success=%s, without waiting for save', async ok => {
    const f = fixture(); const service = f.create(); await service.run();
    f.setTime(f.getTime() + DAY / 2);
    f.fetch.mockResolvedValue({ ok, models: [] });
    const result = await service.fetchSaved('example', 'codex');
    expect(result.ok).toBe(ok);
    f.setTime(f.getTime() + DAY - 1); await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(4);
    f.setTime(f.getTime() + 1); await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(7);
  });
  it('coalesces manual and automatic queries while manual reset does not suppress remaining runtimes', async () => {
    const f = fixture(); const service = f.create(); const pending = deferred<ProviderModelsFetchResult>();
    f.fetch.mockImplementationOnce(() => pending.promise);
    const auto = service.run();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    f.setTime(f.getTime() + 1000);
    const manual = service.fetchSaved('example', 'claude-code');
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(f.file(), 'utf8')).providers.example.lastAttemptAt).toBe(f.getTime()));
    pending.resolve({ ok: true, models: [] }); await Promise.all([auto, manual]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect((await manual).snapshot?.agent).toBe('claude-code');
  });
  it('serializes multiple connections across overlapping background triggers', async () => {
    const f = fixture(); f.configs.set('second', { ...f.configs.get('example')!, id: 'second' });
    let active = 0; let maximum = 0;
    f.fetch.mockImplementation(async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return { ok: true, models: [] }; });
    const service = f.create(); await Promise.all([service.run(), service.run()]);
    expect(f.fetch).toHaveBeenCalledTimes(6); expect(maximum).toBe(1);
  });
  it.each(['owner', 'revision', 'mutation', 'stop'] as const)('discards in-flight results and stops following requests after %s changes', async change => {
    const f = fixture(); const service = f.create(); const pending = deferred<ProviderModelsFetchResult>();
    f.fetch.mockImplementationOnce(() => pending.promise);
    const work = service.run(); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    if (change === 'owner') f.setOwner({ dataOwnerId: 'owner-b', generation: 2 });
    else if (change === 'revision') f.bump();
    else if (change === 'mutation') f.setMutating(true);
    else service.stop();
    pending.resolve({ ok: true, models: [{ id: 'late', name: 'Late' }] }); await work;
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.apply).not.toHaveBeenCalled();
  });
  it('checks ownership after loading a connection before reading any credentials', async () => {
    const f = fixture(); const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async id => { const result = await read(id); f.setOwner({ dataOwnerId: 'owner-b', generation: 2 }); return result; });
    await f.create().run(); expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('does not capture while configuration mutations are in progress', async () => {
    const f = fixture(); f.setMutating(true); await f.create().fetchSaved('example', 'pi');
    expect(f.credentials).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(fs.existsSync(f.file())).toBe(false);
  });
  it('preserves corrupt files and maintains an in-process cooldown', async () => {
    const f = fixture(); fs.writeFileSync(f.file(), '{broken'); const service = f.create();
    await service.run(); await service.run();
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(fs.readFileSync(f.file(), 'utf8')).toBe('{broken');
  });
  it('handles future timestamps once after clock rollback and removes deleted connections', async () => {
    const f = fixture(); fs.writeFileSync(f.file(), JSON.stringify({ version: 1, providers: {
      example: { lastAttemptAt: f.getTime() + DAY }, removed: { lastAttemptAt: f.getTime() },
    } })); const service = f.create(); await service.run(); await service.run();
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fs.readFileSync(f.file(), 'utf8')).providers).toEqual({ example: { lastAttemptAt: f.getTime() } });
  });
  it('uses the newer cross-process manual timestamp instead of stale memory', async () => {
    const f = fixture(); const service = f.create(); await service.run();
    f.setTime(f.getTime() + DAY / 2); await f.create().fetchSaved('example', 'pi');
    f.setTime(f.getTime() + DAY / 2); await service.run();
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it('fires without a page opening, rechecks on wake and cancels timers on shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(); const service = f.create(); service.start();
    await vi.advanceTimersByTimeAsync(0); await service.run(); expect(f.fetch).toHaveBeenCalledTimes(3);
    f.setTime(f.getTime() + DAY / 2); await service.fetchSaved('example', 'pi');
    f.setTime(f.getTime() + DAY / 2); service.kick(); await vi.advanceTimersByTimeAsync(0); await service.run();
    expect(f.fetch).toHaveBeenCalledTimes(4);
    f.setTime(f.getTime() + DAY / 2); service.kick(); await vi.advanceTimersByTimeAsync(0); await service.run();
    expect(f.fetch).toHaveBeenCalledTimes(7); service.stop();
    await vi.advanceTimersByTimeAsync(DAY); expect(f.fetch).toHaveBeenCalledTimes(7); expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes on its own timer exactly 24 hours after a manual reset', async () => {
    vi.useFakeTimers(); const f = fixture();
    // Isolate timer behavior from real file IO; persistence and cross-controller locks
    // are covered above and below using the actual settings file.
    const store = f.makeStore(); let persisted = store.read();
    const service = f.create({ ...store, read: () => persisted, invalidateIfChanged() {},
      updateAtomic: async updater => {
        persisted = { ...persisted, ...updater({ value: persisted, defaults: { version: 1, providers: {} }, isCustomized: true, customizedKeys: ['providers'] }) };
        return persisted;
      },
    });
    service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    f.setTime(f.getTime() + DAY / 2); await service.fetchSaved('example', 'pi');
    for (let hour = 1; hour <= 24; hour++) {
      f.setTime(f.getTime() + DAY / 24);
      await vi.advanceTimersByTimeAsync(DAY / 24);
      expect(f.fetch).toHaveBeenCalledTimes(hour < 24 ? 4 : 7);
    }
    service.stop();
  });
  it('claims a due connection once across independent controllers sharing the same file', async () => {
    const f = fixture();
    await Promise.all([f.create().run(), f.create().run()]);
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.apply).toHaveBeenCalledOnce();
  });
  it('skips connections without credentials but permits header-only and loopback no-auth routes', async () => {
    const f = fixture(); f.credentials.mockReturnValue({ apiKey: null, headers: undefined });
    await f.create().run(); expect(f.fetch).not.toHaveBeenCalled();
    f.credentials.mockReturnValue({ apiKey: null, headers: { Authorization: 'FAKE-HEADER' } });
    await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(3);
    const config = f.configs.get('example')!; config.auth = { method: 'none' };
    config.runtimes = { pi: { baseUrl: 'http://127.0.0.1:1234/v1', models: [] } };
    f.credentials.mockReturnValue({ apiKey: null, headers: undefined }); f.setTime(f.getTime() + DAY);
    await f.create().run(); expect(f.fetch).toHaveBeenCalledTimes(4);
  });
});
