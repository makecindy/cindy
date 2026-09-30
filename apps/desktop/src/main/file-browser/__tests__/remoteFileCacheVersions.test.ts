import fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cache-versions-'));
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner:1',
  dataOwnerStorageKey: (id: string) => id,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const {
  fetchRemoteFileToCache,
  putCachedContent,
  findStaleCached,
  getRemoteFileCacheRoot,
  __cacheTesting,
} = await import('../remote-file-cache');
const id = {
  transport: 'device' as const,
  endpointId: 'device',
  workdir: '/repo',
  relPath: 'a.txt',
  size: 3,
  mtimeMs: 1000.1,
};
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(userDataDir, { recursive: true, force: true });
});

it.each([true, false])(
  'retains both returned versions when old finishes last: %s',
  async (oldLast) => {
    const newer = { ...id, mtimeMs: 2000 };
    const oldPath = __cacheTesting.cachePathFor(id);
    const newPath = __cacheTesting.cachePathFor(newer);
    // Make the background cleanup's directory listing deterministic, including
    // both versions. The real filesystem still handles writes, stats and removals.
    vi.spyOn(fs, 'readdir').mockResolvedValue([
      path.basename(oldPath),
      path.basename(newPath),
    ] as never);
    const remove = vi.spyOn(fs, 'rm');
    const started = barrier();
    const release = barrier();
    const slow = fetchRemoteFileToCache(
      oldLast ? id : newer,
      async (dest) => {
        started.resolve();
        await release.promise;
        await fs.writeFile(dest, oldLast ? 'old' : 'new');
      },
      vi.fn(),
    );
    await started.promise;
    try {
      await fetchRemoteFileToCache(
        oldLast ? newer : id,
        (dest) => fs.writeFile(dest, oldLast ? 'new' : 'old'),
        vi.fn(),
      );
    } finally {
      release.resolve();
    }
    await slow;
    await __cacheTesting.evictLru();
    expect(remove.mock.calls.some(([p]) => p === oldPath || p === newPath)).toBe(false);
    expect(await fs.readFile(oldPath, 'utf8')).toBe('old');
    expect(await fs.readFile(newPath, 'utf8')).toBe('new');
  },
);

it.each(['文'.repeat(70), '😀'.repeat(60)])(
  'bounds multibyte cache components: %s',
  async (stem) => {
    const file = { ...id, relPath: `${stem}.txt` };
    const result = await fetchRemoteFileToCache(file, (dest) => fs.writeFile(dest, 'new'), vi.fn());
    expect(await fs.readFile(result, 'utf8')).toBe('new');
    expect(Buffer.byteLength(path.basename(result), 'utf8')).toBeLessThanOrEqual(255);
    expect(path.extname(result)).toBe('.txt');
    const inline = { ...file, mtimeMs: 2000 };
    await putCachedContent(inline, 'end');
    expect(await fs.readFile(__cacheTesting.cachePathFor(inline), 'utf8')).toBe('end');
  },
);

it('distinguishes same-size sub-millisecond versions in downloads and write-through', async () => {
  await putCachedContent(id, 'old');
  const changed = { ...id, mtimeMs: 1000.2 };
  const executor = vi.fn((dest: string) => fs.writeFile(dest, 'new'));
  const newPath = await fetchRemoteFileToCache(changed, executor, vi.fn());
  expect(executor).toHaveBeenCalledOnce();
  expect(await fs.readFile(newPath, 'utf8')).toBe('new');
  const hit = vi.fn();
  expect(await fetchRemoteFileToCache(changed, hit, vi.fn())).toBe(newPath);
  expect(hit).not.toHaveBeenCalled();
  await putCachedContent({ ...id, mtimeMs: 1000.3 }, 'end');
  expect(await fs.readFile(__cacheTesting.cachePathFor({ ...id, mtimeMs: 1000.3 }), 'utf8')).toBe(
    'end',
  );
});

it('keeps legacy rounded copies available offline without accepting them as exact hits', async () => {
  const exact = { ...id, mtimeMs: 1000 };
  const currentPath = __cacheTesting.cachePathFor(exact);
  const legacy = path.join(
    getRemoteFileCacheRoot(),
    `${path.basename(currentPath).split('-')[0]}-3-1000-a.txt`,
  );
  await fs.mkdir(getRemoteFileCacheRoot(), { recursive: true });
  await fs.writeFile(legacy, 'old');
  expect(await findStaleCached(exact)).toBe(legacy);
  const executor = vi.fn((dest: string) => fs.writeFile(dest, 'new'));
  expect(await fetchRemoteFileToCache(exact, executor, vi.fn())).toBe(currentPath);
  expect(executor).toHaveBeenCalledOnce();
  expect(await fs.readFile(currentPath, 'utf8')).toBe('new');
});

it.each(['resolve', 'reject'] as const)(
  'isolates a retry from a cancelled executor that later %ss',
  async (settle) => {
    const oldStarted = barrier();
    const releaseOld = barrier();
    const newStarted = barrier();
    const releaseNew = barrier();
    const controller = new AbortController();
    let oldTemp = '';
    let newTemp = '';
    const oldProgress = vi.fn();
    const first = fetchRemoteFileToCache(
      id,
      async (dest, report) => {
        oldTemp = dest;
        await fs.writeFile(dest, 'old');
        oldStarted.resolve();
        await releaseOld.promise;
        report(3, 3);
        if (settle === 'reject') throw new Error('late failure');
        // Deliberately ignore abort and attempt to finish with stale bytes.
      },
      oldProgress,
      controller.signal,
    );
    await oldStarted.promise;
    controller.abort();
    await expect(first).rejects.toThrow('FILE_PEER_CANCELLED');
    const replacement = vi.fn(async (dest: string) => {
      newTemp = dest;
      await fs.writeFile(dest, 'new');
      newStarted.resolve();
      await releaseNew.promise;
    });
    const retry = fetchRemoteFileToCache(id, replacement, vi.fn());
    try {
      await newStarted.promise;
      expect(newTemp).not.toBe(oldTemp);
      releaseOld.resolve();
      await vi.waitFor(async () => {
        await expect(fs.stat(oldTemp)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      expect(await fs.readFile(newTemp, 'utf8')).toBe('new');
      expect(oldProgress).not.toHaveBeenCalled();
      const unexpected = vi.fn();
      const joined = fetchRemoteFileToCache(id, unexpected, vi.fn());
      releaseNew.resolve();
      const result = await retry;
      expect(await joined).toBe(result);
      expect(unexpected).not.toHaveBeenCalled();
      expect(await fs.readFile(result, 'utf8')).toBe('new');
    } finally {
      releaseOld.resolve();
      releaseNew.resolve();
      await retry.catch(() => undefined);
    }
  },
);

it('does not change the retry result when cancellation meets the publication boundary', async () => {
  const publishing = barrier();
  const release = barrier();
  const cleaned = barrier();
  const rename = fs.rename.bind(fs);
  const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
  const rm = fs.rm.bind(fs);
  let oldTemp = '';
  // An async publisher may be queued in the OS while a replacement publishes.
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (from === oldTemp) {
      publishing.resolve();
      await release.promise;
    }
    await rename(from, to);
  });
  vi.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
    renameSync(from, to);
    if (from === oldTemp) publishing.resolve();
  });
  vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    await rm(target, options);
    if (target === oldTemp) cleaned.resolve();
  });
  const controller = new AbortController();
  const first = fetchRemoteFileToCache(
    id,
    async (dest) => {
      oldTemp = dest;
      await fs.writeFile(dest, 'old');
    },
    vi.fn(),
    controller.signal,
  );
  const firstSettled = first.catch(() => undefined);
  await publishing.promise;
  try {
    controller.abort();
    await firstSettled;
    const result = await fetchRemoteFileToCache(id, (dest) => fs.writeFile(dest, 'new'), vi.fn());
    const returnedContent = await fs.readFile(result, 'utf8');
    release.resolve();
    await cleaned.promise;
    expect(await fs.readFile(result, 'utf8')).toBe(returnedContent);
  } finally {
    release.resolve();
    await cleaned.promise;
  }
});

it('does not start work for an already cancelled caller', async () => {
  const controller = new AbortController();
  controller.abort();
  const executor = vi.fn();
  await expect(fetchRemoteFileToCache(id, executor, vi.fn(), controller.signal)).rejects.toThrow(
    'FILE_PEER_CANCELLED',
  );
  expect(executor).not.toHaveBeenCalled();
});
