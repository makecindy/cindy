import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companionEnvironmentKey, createCompanionEnvironmentStore } from '../environment.js';
import { runImportedProcess } from '../process.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-environment-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('restores private variables from the credential store after restart and a real subprocess consumes them', async () => {
  const secrets = new Map<string, string>();
  const io = { read: (key: string) => secrets.get(key) ?? null, write: (key: string, value: string) => { secrets.set(key, value); return true; }, remove: (key: string) => { secrets.delete(key); return true; } };
  const store = createCompanionEnvironmentStore(io);
  await store.write(root, 'fixture', { version: 1, env: { DATA_TOKEN: 'fake-token-only-for-test' }, mcp: [], credentials: [] }, () => {});
  const manifest = await fs.readFile(path.join(root, 'bots/fixture/environment.json'), 'utf8');
  expect(manifest).not.toContain('fake-token-only-for-test');
  const restarted = createCompanionEnvironmentStore(io);
  const restored = await restarted.read(root, 'fixture', () => {});
  const output = await runImportedProcess({ command: process.execPath, args: ['-e', 'process.stdout.write(process.env.DATA_TOKEN === "fake-token-only-for-test" ? "authenticated" : "missing")'], cwd: root, env: restored!.env, timeoutMs: 5000, signal: new AbortController().signal, assertOwner() {} });
  expect(output).toEqual({ stdout: 'authenticated', exitCode: 0 });
  expect(process.env.DATA_TOKEN).not.toBe('fake-token-only-for-test');
  await expect(restarted.read(root, 'fixture', () => { throw new Error('account changed'); })).rejects.toThrow('account changed');
});
it('does not publish a usable manifest when secure storage rejects credentials', async () => {
  const store = createCompanionEnvironmentStore({ read: () => null, write: () => false, remove: () => true });
  await expect(store.write(root, 'fixture', { version: 1, env: { KEY: 'fake' }, mcp: [], credentials: [] }, () => {})).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  await expect(fs.access(path.join(root, 'bots/fixture/environment.json'))).rejects.toThrow();
});

it('retains credentials before deletion commits and retries failed cleanup after restart', async () => {
  const values = new Map<string, string>();
  const remove = vi.fn((key: string) => { values.delete(key); return true; });
  const io = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => { values.set(key, value); return true; }, remove };
  const store = createCompanionEnvironmentStore(io);
  const environment = { version: 1 as const, env: { TOKEN: 'fixture-secret' }, mcp: [], credentials: [] };
  await store.write(root, 'fixture', environment, () => {});
  remove.mockClear();
  await store.stageRemoval(root, 'fixture', () => {});
  const marker = path.join(root, 'companion-import-cleanups/fixture.json');
  expect(await fs.readFile(marker, 'utf8')).not.toContain('fixture-secret');
  // A prepared deletion that rolled back in SQLite must leave the vault usable.
  await createCompanionEnvironmentStore(io).recoverRemovals(root, () => {}, async () => true);
  expect(await store.read(root, 'fixture', () => {})).toEqual(environment);
  expect(remove).not.toHaveBeenCalled();
  // The profile and folder are now gone, but the vault cannot be updated yet.
  await fs.rm(path.join(root, 'bots/fixture'), { recursive: true });
  remove.mockReturnValueOnce(false);
  await expect(store.finishRemoval(root, 'fixture', () => {})).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  expect(values.size).toBe(2);
  expect(await fs.readFile(marker, 'utf8')).toContain('fixture');
  const restarted = createCompanionEnvironmentStore(io);
  await restarted.recoverRemovals(root, () => {}, async () => false);
  expect(values.size).toBe(0);
  await expect(fs.access(marker)).rejects.toThrow();
  await restarted.recoverRemovals(root, () => {}, async () => false);
  expect(remove).toHaveBeenCalledTimes(3);
});

it('retains pending cleanup if ownership changes while checking the committed profile state', async () => {
  const remove = vi.fn(() => true);
  const store = createCompanionEnvironmentStore({ read: () => 'existing-private-checkpoint', write: () => true, remove });
  await store.stageRemoval(root, 'fixture', () => {});
  let current = true;
  const assertOwner = () => { if (!current) throw new Error('owner changed'); };
  await expect(store.recoverRemovals(root, assertOwner, async () => { current = false; return false; })).rejects.toThrow('owner changed');
  expect(remove).not.toHaveBeenCalled();
  await expect(fs.access(path.join(root, 'companion-import-cleanups/fixture.json'))).resolves.toBeUndefined();
});

it('does no cleanup writes for ordinary companions even when the cleanup path is a file', async () => {
  const file = path.join(root, 'companion-import-cleanups');
  await fs.writeFile(file, 'unrelated file');
  const io = { has: vi.fn(() => false), read: vi.fn(() => { throw new Error('vault locked'); }), write: vi.fn(() => true), remove: vi.fn(() => true) };
  const store = createCompanionEnvironmentStore(io);
  await store.stageRemoval(root, 'ordinary', () => {});
  await store.finishRemoval(root, 'ordinary', () => {});
  await store.recoverRemovals(root, () => {}, async () => false);
  expect(await fs.readFile(file, 'utf8')).toBe('unrelated file');
  expect(await fs.readdir(root)).toEqual(['companion-import-cleanups']);
  expect(io.write).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
  expect(io.read).not.toHaveBeenCalled();
});

it('still stages a vault-only checkpoint left before the binding was written', async () => {
  const values = new Map([[companionEnvironmentKey('fixture'), 'private-checkpoint']]);
  const store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: () => true, remove: key => { values.delete(key); return true; } });
  await store.stageRemoval(root, 'fixture', () => {});
  await store.finishRemoval(root, 'fixture', () => {});
  expect(values.size).toBe(0);
});

it('keeps credential-bearing connection and variable names out of the binding without changing private originals', async () => {
  const values = new Map<string, string>();
  const io = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: string) => { values.set(key, value); return true; }, remove: () => true };
  const environment = { version: 1 as const, env: { 'name-with-fixture-secret': 'fixture-secret' }, credentials: [], mcp: [{ name: 'fixture-secret', url: 'https://example.invalid/mcp/fixture-secret', headers: { Authorization: 'Bearer fixture-secret' } }] };
  await createCompanionEnvironmentStore(io).write(root, 'fixture', environment, () => {});
  const text = await fs.readFile(path.join(root, 'bots/fixture/environment.json'), 'utf8');
  expect(text).not.toContain('fixture-secret');
  const manifest = JSON.parse(text);
  expect(manifest.connections).toHaveLength(1); expect(manifest.variables).toHaveLength(1);
  expect(await createCompanionEnvironmentStore(io).read(root, 'fixture', () => {})).toEqual(environment);
});

it('joins asynchronous writes before committed deletion removes credentials', async () => {
  const values = new Map<string, string>();
  let release!: () => void;
  let pending = false; let writingStarted = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const io = {
    read: (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => { if (pending) { writingStarted = true; await barrier; } values.set(key, value); return true; },
    remove: (key: string) => { values.delete(key); return true; },
  };
  const store = createCompanionEnvironmentStore(io);
  const environment = { version: 1 as const, env: { TOKEN: 'fixture-only-secret' }, mcp: [], credentials: [] };
  await store.write(root, 'fixture', environment, () => {});
  await store.stageRemoval(root, 'fixture', () => {});
  pending = true; let current = true;
  const writing = store.write(root, 'fixture', environment, () => { if (!current) throw new Error('companion deleted'); });
  const rejected = expect(writing).rejects.toThrow('companion deleted');
  await vi.waitFor(() => expect(writingStarted).toBe(true));
  current = false;
  let removed = false;
  const removal = store.finishRemoval(root, 'fixture', () => {}).then(() => { removed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(removed).toBe(false);
  release();
  await rejected; await removal;
  expect(values.size).toBe(0);
});

it('recovers media cleanup before removing the private import checkpoint', async () => {
  const remove = vi.fn(() => true);
  const removeResources = vi.fn().mockRejectedValueOnce(new Error('ledger unavailable')).mockResolvedValue(undefined);
  const store = createCompanionEnvironmentStore({ read: () => 'private-checkpoint', write: () => true, remove, removeResources });
  await store.stageRemoval(root, 'fixture', () => {});
  await expect(store.finishRemoval(root, 'fixture', () => {})).rejects.toThrow('ledger unavailable');
  expect(remove).not.toHaveBeenCalled();
  await expect(fs.access(path.join(root, 'companion-import-cleanups/fixture.json'))).resolves.toBeUndefined();
  await store.recoverRemovals(root, () => {}, async () => false);
  expect(removeResources).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(2);
  await expect(fs.access(path.join(root, 'companion-import-cleanups/fixture.json'))).rejects.toThrow();
});
