import { copyFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { snapshotContent, type ContentGit } from '../sourceContent';
import { runSourceGit } from '../sourceGit';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

afterEach(() => {
  vi.mocked(copyFile).mockReset();
  vi.restoreAllMocks();
});

// The second fixture also catches Stats.mtime rounding up into the next second.
// The third models clock rollback: copied index < cached file < original index.
// The remaining fixtures model Windows CopyFileW preserving the index mtime,
// with a clock at the end of a second, crossing forward, or rolling backward.
const futureTick = Math.floor(Date.now() / 1000) + 3600;
it.each<[number, number, { before: number; after: number }?]>([
  [1_700_000_000, 1_700_000_000],
  [1_700_000_000.9999, 1_700_000_000.9999],
  [futureTick, futureTick + 3600],
  [1_700_000_000.9999, 1_700_003_600, { before: 1_700_000_000_999, after: 1_700_000_000_999 }],
  [1_700_000_000.9999, 1_700_003_600, { before: 1_700_000_000_999, after: 1_700_000_001_000 }],
  [1_700_000_000.9999, 1_700_003_600, { before: 1_700_000_001_000, after: 1_700_000_000_999 }],
])('snapshots a racily clean edit without changing the real index (%s, %s, %j)', async (tick, indexTick, clock) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-content-racy-'));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git: ContentGit = (args, cwd, indexFile) => runSourceGit(
    { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
    args, cwd, AbortSignal.timeout(30_000),
  );
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    await git(['init', '--initial-branch=main'], root);
    // Model a same-tick, equal-size rewrite without depending on runner speed
    // or whether this Git build compares subsecond timestamps.
    await git(['config', 'core.trustctime', 'false'], root);
    await git(['config', 'core.checkStat', 'minimal'], root);
    const file = path.join(root, 'feature.txt');
    await writeFile(file, 'release()\nacquire()\n');
    await utimes(file, tick, tick);
    await git(['add', 'feature.txt'], root);
    const index = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root)).trim();
    await utimes(index, indexTick, indexTick);
    const before = await readFile(index);
    const beforeStat = await stat(index);
    const staged = await git(['rev-parse', ':feature.txt'], root);
    await writeFile(file, 'acquire()\nrelease()\n');
    await utimes(file, tick, tick);
    const restored = await git(['hash-object', 'feature.txt'], root);
    expect(restored).not.toBe(staged);

    if (clock) {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let now = clock.before;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
        await actual.copyFile(...args);
        await utimes(args[1], indexTick, indexTick);
        expect((await stat(args[1])).mtimeMs).toBe(beforeStat.mtimeMs);
        now = clock.after;
      });
    }
    const tree = await snapshotContent(git, root);
    expect(await git(['rev-parse', `${tree}:feature.txt`], root)).toBe(restored);
    expect(await readFile(file, 'utf8')).toBe('acquire()\nrelease()\n');
    expect(await readFile(index)).toEqual(before);
    expect((await stat(index)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await git(['rev-parse', ':feature.txt'], root)).toBe(staged);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 60_000);
