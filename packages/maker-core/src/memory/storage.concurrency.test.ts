import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './storage.js';
import { MakerMemoryStore } from './store.js';
import { MemoryError } from './types.js';
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
  it('retains the exact-body format through editor and tool updates to an imported shard', async () => {
    await storage.write({ ...seed, mode: 'update', body: '  Original\n\n', preserveBody: true });
    const imported = await storage.read(filename);
    expect(imported.frontmatter.bodyLength).toBe(imported.body.length);
    const body = '\tOriginal\n';
    const edited = await storage.update(filename, imported.frontmatter.updatedAt, { ...seed, body });
    expect(edited.body).toBe(body);
    expect(edited.frontmatter.bodyLength).toBe(body.length);
    const toolBody = '\nOriginal  ';
    await storage.write({ ...seed, mode: 'update', body: toolBody });
    const saved = await storage.read(filename);
    expect(saved.body).toBe(toolBody);
    expect(saved.frontmatter.bodyLength).toBe(toolBody.length);
  });

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

/*
 * 测试价值
 * - 生产入口与可观察结果：MakerMemoryStore.init（getStore 打开记忆的入口）与 MemoryStorage.write
 *   在 Windows 文件替换语义下是否成功落盘。
 * - Bug／规则依据：Windows unit tests 上 manager.scope.test.ts「同 workdir 并发 getStore」间歇失败
 *   （PR #10035 a73f4a3、#10037 92a0e69）：两个 store 同时首次打开同一文件夹，各自 rename 替换
 *   meta.json / MEMORY.md，重叠的 rename 报 EPERM；杀毒、索引器短暂占用目标时单次 rename 也会 EPERM。
 * - 现有覆盖缺口：POSIX 上重叠 rename 不报错，只有 Windows runner 偶发暴露；这里按 Windows 语义模拟。
 *   重试必须在每次 rename 前复核账号，退避期间切换账号不得覆盖旧账号的记忆（PR #10044 review）。
 * - 最小失败输入：同一文件夹两个 store 并发 init；目标被短暂占用、首次 rename 返回 EPERM 的一次写入；
 *   首次 rename EPERM 后账号切换。
 * - tier：unit（临时目录真实文件 I/O，只替换 rename 的失败语义）。
 */
describe('replacing memory files under Windows rename semantics', () => {
  function windowsRename(lockedOnce: Set<string> = new Set()) {
    const rename = fs.rename.bind(fs);
    const inFlight = new Set<string>();
    return vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const target = path.resolve(String(to));
      const locked = lockedOnce.delete(target);
      if (locked || inFlight.has(target)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), { code: 'EPERM' });
      }
      inFlight.add(target);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        await rename(from, to);
      } finally {
        inFlight.delete(target);
      }
    });
  }

  it('opens two stores on the same folder at once without overlapping replacements', async () => {
    const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    const dbs = [new Database(':memory:'), new Database(':memory:')];
    const rename = windowsRename();
    try {
      const stores = dbs.map((db) => new MakerMemoryStore({ storageDir: dir, absWorkdir: dir, db, logger }));
      await Promise.all(stores.map((store) => store.init()));
      for (const store of stores) expect(await store.getIndex()).toContain(`[${filename}] Original`);
      expect(rename.mock.settledResults.filter((r) => r.type === 'rejected')).toEqual([]);
    } finally {
      for (const db of dbs) db.close();
    }
  });

  it('saves a memory when its file is briefly locked by another program', async () => {
    windowsRename(new Set([path.resolve(dir, filename)]));
    await storage.write({ ...seed, mode: 'update', body: 'Saved through a lock' });
    expect((await storage.read(filename)).body).toBe('Saved through a lock');
  });

  it('does not replace the old account memory when the account switches while waiting out a lock', async () => {
    let switched = false;
    const guarded = new MemoryStorage(dir, undefined, () => {
      if (switched) throw new MemoryError('not-ready', 'owner scope changed');
    });
    windowsRename().mockImplementationOnce(async () => {
      switched = true;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    await expect(guarded.write({ ...seed, mode: 'update', body: 'Written for the old account' }))
      .rejects.toMatchObject({ code: 'not-ready' });
    expect((await storage.read(filename)).body).toBe('Original');
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：MemoryStorage 的 write / list / rebuildIndex 对记忆文件夹里被换成链接的文件的处理，
 *   看链接指向的真实文件是否被改写或读进记忆。
 * - 规则依据：伙伴记忆搬进伙伴项目 `.cindy/memory/`（2026-11-09），该文件夹可被任务的文件工具改动；
 *   宿主写记忆不得顺着链接写到文件夹外，也不得把链接指向的文件读成记忆。
 * - 现有覆盖缺口：记忆此前只在任务碰不到的宿主目录，没有链接相关覆盖。
 * - 最小失败输入：一条记录与 MEMORY.md 被换成指向文件夹外文件的链接后再写一次。
 * - tier：unit（临时目录真实文件 I/O）。
 */
// symlink-platform-skip: Windows creates file symbolic links only with Developer Mode or administrator rights.
describe.skipIf(process.platform === 'win32')('links in the memory folder', () => {
  it('never writes through a link and never reads one as a memory', async () => {
    const outside = path.join(dir, '..', `${path.basename(dir)}-outside.txt`);
    await fs.writeFile(outside, 'not a memory', 'utf8');
    try {
      await fs.rm(path.join(dir, filename));
      await fs.symlink(outside, path.join(dir, filename));
      await fs.rm(path.join(dir, 'MEMORY.md'));
      await fs.symlink(outside, path.join(dir, 'MEMORY.md'));
      expect(await storage.list()).toEqual([]);

      await storage.write({ ...seed, body: 'Rewritten' });
      expect(await fs.readFile(outside, 'utf8')).toBe('not a memory');
      expect((await fs.lstat(path.join(dir, filename))).isSymbolicLink()).toBe(false);
      expect((await fs.lstat(path.join(dir, 'MEMORY.md'))).isSymbolicLink()).toBe(false);
      expect((await storage.read(filename)).body).toBe('Rewritten');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
