import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ scope: 'owner-a:1' }));
const userDataDir = path.join(os.tmpdir(), `remote-cache-owner-${randomUUID()}`);
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  dataOwnerStorageKey: (id: string) => id,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
const { fetchRemoteFileToCache, findStaleCached, putCachedContent, getRemoteFileCacheRoot } =
  await import('../remote-file-cache');
const id = {
  transport: 'device' as const,
  endpointId: 'device',
  workdir: '/repo',
  relPath: 'a.txt',
  size: 3,
  mtimeMs: 1,
};
afterEach(async () => {
  vi.restoreAllMocks();
  state.scope = 'owner-a:1';
  await fs.rm(userDataDir, { recursive: true, force: true });
});

it('cancels the download and coalesced waiter after an owner switch, removing staging bytes', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const progress = vi.fn();
  const executor = vi.fn(async (dest: string) => {
    await fs.writeFile(dest, 'old');
    started();
    await pause;
  });
  const first = fetchRemoteFileToCache(id, executor, progress);
  await ready;
  const second = fetchRemoteFileToCache(id, executor, progress);
  const settled = Promise.allSettled([first, second]);
  state.scope = 'owner-b:2';
  release();
  for (const result of await settled) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.message).toBe('FILE_PEER_CANCELLED');
  }
  expect(executor).toHaveBeenCalledTimes(1);
  expect(progress).not.toHaveBeenCalled();
  expect(await fs.readdir(getRemoteFileCacheRoot())).toEqual([]);
});

it('does not return a cache hit or report progress when ownership changes during touch', async () => {
  await putCachedContent(id, 'old');
  vi.spyOn(fs, 'utimes').mockImplementationOnce(async () => {
    state.scope = 'owner-b:2';
  });
  const executor = vi.fn();
  const progress = vi.fn();
  await expect(fetchRemoteFileToCache(id, executor, progress)).rejects.toThrow(
    'FILE_PEER_CANCELLED',
  );
  expect(executor).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});

it('does not return a stale cache path after an owner switch during lookup', async () => {
  await putCachedContent(id, 'old');
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementationOnce((async (...args: Parameters<typeof fs.stat>) => {
    const result = await stat(...args);
    state.scope = 'owner-b:2';
    return result;
  }) as typeof fs.stat);
  await expect(findStaleCached(id)).rejects.toThrow('FILE_PEER_CANCELLED');
});

it('discards write-through bytes when ownership changes during the write', async () => {
  const write = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
    await write(...args);
    state.scope = 'owner-b:2';
  });
  await putCachedContent(id, 'old');
  expect(await fs.readdir(getRemoteFileCacheRoot())).toEqual([]);
});
