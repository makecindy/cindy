import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './storage.js';
import { MakerMemoryStore } from './store.js';
import Database from 'better-sqlite3';
import type { Logger } from '../interfaces/logger.js';

let dir: string;
let storage: MemoryStorage;
const seed = { type: 'user' as const, name: 'preference', title: 'Original', description: 'Original', body: 'Original' };
const filename = 'user_preference.md';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-memory-concurrency-'));
  storage = new MemoryStorage(dir);
  await storage.write(seed);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

// Pause real file I/O so a competing operation enters the exact read/write window.
function pauseNextRead() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
    const result = await read(...args);
    entered();
    await gate;
    return result;
  });
  return { started, release };
}

describe('conditional memory mutations', () => {
  it.each(['update', 'delete'] as const)('rejects stale %s after an in-flight tool write, across storage instances', async (operation) => {
    const opened = await storage.read(filename);
    const pause = pauseNextRead();
    const toolWrite = storage.write({ ...seed, mode: 'update', body: 'Teammate update' });
    await pause.started;
    const editor = new MemoryStorage(dir);
    const mutation = operation === 'update'
      ? editor.update(filename, opened.frontmatter.updatedAt, { title: 'Mine', description: 'Mine', body: 'Mine' })
      : editor.delete(filename, opened.frontmatter.updatedAt);
    const rejected = expect(mutation).rejects.toMatchObject({ code: 'version-conflict' });
    pause.release();
    await toolWrite;
    await rejected;
    expect((await storage.read(filename)).body).toBe('Teammate update');
  });

  it('keeps tool writes outside an editor version-check/write window', async () => {
    const opened = await storage.read(filename);
    const pause = pauseNextRead();
    const edit = storage.update(filename, opened.frontmatter.updatedAt, { title: 'Mine', description: 'Mine', body: 'Mine' });
    await pause.started;
    const toolWrite = storage.write({ ...seed, mode: 'update', body: 'Later teammate update' });
    pause.release();
    const [saved] = await Promise.all([edit, toolWrite]);
    expect(saved.body).toBe('Mine');
    expect((await storage.read(filename)).body).toBe('Later teammate update');
  });

  it('changes the version even when consecutive writes have the same clock time', async () => {
    const opened = await storage.read(filename);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(opened.frontmatter.updatedAt));
    await storage.write({ ...seed, mode: 'update', body: 'Changed' });
    expect((await storage.read(filename)).frontmatter.updatedAt).not.toBe(opened.frontmatter.updatedAt);
    await expect(storage.delete(filename, opened.frontmatter.updatedAt)).rejects.toMatchObject({ code: 'version-conflict' });
  });

  it('keeps the real store index and FTS synchronized after editing and deleting a legacy file', async () => {
    const legacy = 'user_user_preference.md';
    await fs.copyFile(path.join(dir, filename), path.join(dir, legacy));
    const db = new Database(':memory:');
    const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    const store = new MakerMemoryStore({ storageDir: dir, absWorkdir: dir, db, logger });
    try {
      const opened = await store.read(legacy);
      const saved = await store.update(legacy, opened.frontmatter.updatedAt, { title: 'New title', description: 'New summary', body: 'uniquememorykeyword' });
      expect(saved.body).toBe('uniquememorykeyword');
      expect(await store.search('uniquememorykeyword')).toEqual([expect.objectContaining({ filename: legacy })]);
      expect(await store.getIndex()).toContain(`[${legacy}] New title`);
      await store.delete(legacy, saved.frontmatter.updatedAt);
      expect(await store.search('uniquememorykeyword')).toEqual([]);
      expect((await store.read(filename)).body).toBe('Original');
    } finally {
      db.close();
    }
  });

  it('releases the queue after a rejected mutation', async () => {
    await expect(storage.update(filename, 'stale', seed)).rejects.toMatchObject({ code: 'version-conflict' });
    await storage.write({ ...seed, mode: 'update', body: 'Recovered' });
    expect((await storage.read(filename)).body).toBe('Recovered');
  });
});
