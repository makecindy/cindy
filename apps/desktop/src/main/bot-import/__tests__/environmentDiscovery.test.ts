import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companionEnvironmentKey, companionDiscoveryKey, createCompanionEnvironmentStore, type CompanionEnvironment } from '../environment.js';
import { projectEnvironmentDiscovery } from '../environmentJson.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-discovery-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const fixture = (): CompanionEnvironment => ({ version: 1, env: { TOKEN: 'fixture-token' }, mcp: [{ name: 'data', url: 'https://example.invalid/mcp' }],
  credentials: [{ id: 'config', format: 'json', value: { token: 'fixture-credential' } }],
  memoryFiles: { 'original.txt': 'fixture-original'.repeat(100000) },
  pendingImport: { selection: { previewId: 'preview', requestId: 'fixture-request-discovery', name: 'Ada', entryIds: ['one'], takeover: true }, snapshotJson: 'fixture-snapshot'.repeat(100000) } });
function storage() {
  const values = new Map<string, string>();
  const io = { read: vi.fn((key: string) => values.get(key) ?? null),
    write: vi.fn((key: string, value: string) => { values.set(key, value); return true; }),
    remove: vi.fn((key: string) => { values.delete(key); return true; }) };
  return { values, io, store: createCompanionEnvironmentStore(io) };
}

it('discovers repeatedly after restart without reading the archive, while retry restores every original', async () => {
  const { values, io, store } = storage(); const original = fixture();
  await store.write(root, 'bot', original, () => {});
  const restarted = createCompanionEnvironmentStore(io); io.read.mockClear();
  for (let i = 0; i < 3; i++) {
    const result = await restarted.readDiscovery(root, 'bot', () => {});
    expect(result).toMatchObject({ env: original.env, mcp: original.mcp, pendingImport: true });
    expect(Object.keys(result!).sort()).toEqual(['env', 'identity', 'mcp', 'pendingImport']);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  }
  expect(io.read.mock.calls.every(([key]) => key === companionDiscoveryKey('bot'))).toBe(true);
  expect(await restarted.read(root, 'bot', () => {})).toEqual(original);
  const binding = await fs.readFile(path.join(root, 'bots/bot/environment.json'), 'utf8');
  expect(binding).not.toContain('fixture-token'); expect(binding).not.toContain('fixture-snapshot');
  expect(values.get(companionDiscoveryKey('bot'))).not.toContain('fixture-original');
});

it('derives legacy or missing/corrupt discovery data once without rewriting the original archive', async () => {
  const { values, io, store } = storage(); const original = fixture();
  await fs.mkdir(path.join(root, 'bots/bot'), { recursive: true });
  await fs.writeFile(path.join(root, 'bots/bot/environment.json'), JSON.stringify({ version: 1 }));
  const archive = JSON.stringify(original); values.set(companionEnvironmentKey('bot'), archive);
  for (const cache of [undefined, 'corrupt', JSON.stringify({ version: 1, revision: 'stale', environment: {} })]) {
    if (cache === undefined) values.delete(companionDiscoveryKey('bot')); else values.set(companionDiscoveryKey('bot'), cache);
    io.read.mockClear(); io.write.mockClear();
    const results = await Promise.all(Array.from({ length: 3 }, () => store.readDiscovery(root, 'bot', () => {})));
    expect(results[0]).toEqual(projectEnvironmentDiscovery(original));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(io.read.mock.calls.filter(([key]) => key === companionEnvironmentKey('bot'))).toHaveLength(1);
    expect(io.write.mock.calls.map(([key]) => key)).toEqual([companionDiscoveryKey('bot')]);
    expect(values.get(companionEnvironmentKey('bot'))).toBe(archive);
  }
});

it('recovers the current archive after projection publication fails and cleans a projection-only orphan', async () => {
  const { values, io, store } = storage(); await store.write(root, 'bot', fixture(), () => {});
  const write = io.write.getMockImplementation()!;
  io.write.mockImplementationOnce(write).mockImplementationOnce(() => false);
  const changed = { ...fixture(), env: { TOKEN: 'replacement' } };
  await expect(store.write(root, 'bot', changed, () => {})).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  io.read.mockImplementationOnce(() => { throw new Error('corrupt derived ciphertext'); });
  expect(await store.readDiscovery(root, 'bot', () => {})).toEqual(projectEnvironmentDiscovery(changed));
  expect(await store.read(root, 'bot', () => {})).toEqual(changed);
  await fs.rm(path.join(root, 'bots/bot'), { recursive: true });
  values.delete(companionEnvironmentKey('bot'));
  await store.stageRemoval(root, 'bot', () => {});
  await store.finishRemoval(root, 'bot', () => {});
  expect(values.size).toBe(0);
});

it('refreshes connections and credential identity after updates and removes the setup tool flag on completion', async () => {
  const { store } = storage(); await store.write(root, 'bot', fixture(), () => {});
  const first = await store.readDiscovery(root, 'bot', () => {});
  await store.update(root, 'bot', () => {}, value => { value.credentials[0]!.value = 'changed'; });
  const next = await store.readDiscovery(root, 'bot', () => {});
  expect(next!.identity).not.toBe(first!.identity);
  await store.update(root, 'bot', () => {}, value => { value.env = { TOKEN: 'new-token' }; value.mcp = []; delete value.pendingImport; });
  expect(await store.readDiscovery(root, 'bot', () => {})).toMatchObject({ env: { TOKEN: 'new-token' }, mcp: [], pendingImport: false });
});

it('never reuses stale discovery after an interrupted write and joins rebuilds before deletion', async () => {
  const { values, io, store } = storage(); await store.write(root, 'bot', fixture(), () => {});
  io.write.mockImplementationOnce(() => false);
  await expect(store.write(root, 'bot', { ...fixture(), env: { TOKEN: 'replacement' } }, () => {})).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  expect(values.has(companionDiscoveryKey('bot'))).toBe(false);
  expect(await store.readDiscovery(root, 'bot', () => {})).toMatchObject({ env: { TOKEN: 'fixture-token' } });
  values.delete(companionDiscoveryKey('bot'));
  await store.stageRemoval(root, 'bot', () => {});
  let current = true; let release!: () => void; let started = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const asyncIo = { ...io, write: async (key: string, value: string) => { started = true; await barrier; values.set(key, value); return true; } };
  const restarted = createCompanionEnvironmentStore(asyncIo);
  const reading = restarted.readDiscovery(root, 'bot', () => { if (!current) throw new Error('owner changed'); });
  const rejected = expect(reading).rejects.toThrow('owner changed');
  await vi.waitFor(() => expect(started).toBe(true)); current = false;
  const removing = restarted.finishRemoval(root, 'bot', () => {});
  release(); await rejected; await removing;
  expect(values.size).toBe(0);
});
