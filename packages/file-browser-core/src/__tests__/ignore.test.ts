/**
 * loadIgnoreMatcher cache + inflight 单测 —— 验证:
 *   1. 同一 workdir 的并发调用通过 inflight 去重(只触发一次 disk 读+ig.add)
 *   2. 后续调用命中 cache,不再读盘
 *   3. .gitignore mtime 变化后下一次调用会重建
 *   4. hideMetaFiles 不同的请求各自独立缓存
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __clearCacheForTesting, loadIgnoreMatcher } from '../ignore';

async function makeWorkdir(gitignore?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignore-test-'));
  if (gitignore !== undefined) {
    await fs.writeFile(path.join(dir, '.gitignore'), gitignore, 'utf8');
  }
  return dir;
}

describe('loadIgnoreMatcher cache + inflight', () => {
  let workdir: string;

  beforeEach(async () => {
    // Cache + inflight are module-level; clear between cases so isolation is
    // explicit rather than relying on `mkdtemp` paths being unique by accident.
    __clearCacheForTesting();
    workdir = await makeWorkdir('logs/\n*.tmp\n');
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('并发调用走 inflight,只读盘一次', async () => {
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const [m1, m2, m3] = await Promise.all([
      loadIgnoreMatcher(workdir),
      loadIgnoreMatcher(workdir),
      loadIgnoreMatcher(workdir),
    ]);
    // Three concurrent callers share a single read of .gitignore.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    // Same matcher instance — inflight dedup, not three separate builds.
    expect(m1).toBe(m2);
    expect(m2).toBe(m3);
    expect(m1.ignores('logs/foo.txt', false)).toBe(true);
    expect(m1.ignores('foo.tmp', false)).toBe(true);
    expect(m1.ignores('keep.txt', false)).toBe(false);
  });

  it('mtime 不变时后续调用走 cache,不再读盘', async () => {
    await loadIgnoreMatcher(workdir);
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const matcher = await loadIgnoreMatcher(workdir);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(matcher.ignores('foo.tmp', false)).toBe(true);
  });

  it('.gitignore mtime 变化后会重建', async () => {
    const before = await loadIgnoreMatcher(workdir);
    expect(before.ignores('build.log', false)).toBe(false);

    // Bump mtime forward — same content is enough to trigger fs to update
    // mtime on most filesystems, but writeFile with a new payload is more
    // robust across platforms.
    const futureMs = Date.now() + 5_000;
    await fs.writeFile(path.join(workdir, '.gitignore'), '*.log\n', 'utf8');
    await fs.utimes(path.join(workdir, '.gitignore'), futureMs / 1000, futureMs / 1000);

    const after = await loadIgnoreMatcher(workdir);
    expect(after).not.toBe(before);
    expect(after.ignores('build.log', false)).toBe(true);
    // Old rules dropped.
    expect(after.ignores('foo.tmp', false)).toBe(false);
  });

  it('honorVcsIgnore=false 时保留用户真实目录但仍过滤内置大目录和 .meta', async () => {
    const matcher = await loadIgnoreMatcher(workdir, { honorVcsIgnore: false });
    expect(matcher.ignores('RawAssets/', true)).toBe(false);
    expect(matcher.ignores('foo.tmp', false)).toBe(false);
    expect(matcher.ignores('node_modules/', true)).toBe(true);
    expect(matcher.ignores('Foo.cs.meta', false)).toBe(true);
  });

  it('hideMetaFiles 不同时各自缓存', async () => {
    const withMeta = await loadIgnoreMatcher(workdir, { hideMetaFiles: false });
    const withoutMeta = await loadIgnoreMatcher(workdir, { hideMetaFiles: true });
    expect(withMeta).not.toBe(withoutMeta);
    expect(withMeta.ignores('Foo.cs.meta', false)).toBe(false);
    expect(withoutMeta.ignores('Foo.cs.meta', false)).toBe(true);
  });

  it('缓存 .p4ignore 时,新出现的 .gitignore 会让下次调用切到高优先级源', async () => {
    const dir = await makeWorkdir();
    try {
      // Initial state: only .p4ignore present.
      await fs.writeFile(path.join(dir, '.p4ignore'), '*.bak\n', 'utf8');
      const m1 = await loadIgnoreMatcher(dir);
      expect(m1.ignores('foo.bak', false)).toBe(true);

      // .gitignore appears with different rules; should override .p4ignore.
      await fs.writeFile(path.join(dir, '.gitignore'), '*.log\n', 'utf8');
      const m2 = await loadIgnoreMatcher(dir);
      expect(m2).not.toBe(m1);
      expect(m2.ignores('foo.log', false)).toBe(true);
      expect(m2.ignores('foo.bak', false)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('无 .gitignore 时也缓存,出现新文件后下一次重建', async () => {
    const empty = await makeWorkdir();
    try {
      const m1 = await loadIgnoreMatcher(empty);
      // Cache hit: should reuse without rebuild.
      const m2 = await loadIgnoreMatcher(empty);
      expect(m2).toBe(m1);
      // Now drop a .gitignore in — next call must rebuild.
      await fs.writeFile(path.join(empty, '.gitignore'), '*.bak\n', 'utf8');
      const m3 = await loadIgnoreMatcher(empty);
      expect(m3).not.toBe(m1);
      expect(m3.ignores('foo.bak', false)).toBe(true);
    } finally {
      await fs.rm(empty, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('loadIgnoreMatcher 内置忽略分层 (showIgnoredDirs)', () => {
  let workdir: string;

  beforeEach(async () => {
    __clearCacheForTesting();
    workdir = await makeWorkdir();
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  it('默认隐藏依赖 / 构建产物 / 缓存目录', async () => {
    const matcher = await loadIgnoreMatcher(workdir, { honorVcsIgnore: false });
    for (const dir of ['build', 'dist', 'out', 'bin', 'obj', 'target', 'vendor', 'Temp', 'Logs']) {
      expect(matcher.ignores(`${dir}/`, true), dir).toBe(true);
    }
  });

  it('showIgnoredDirs 放行依赖 / 构建产物 / 缓存目录', async () => {
    const matcher = await loadIgnoreMatcher(workdir, {
      honorVcsIgnore: false,
      showIgnoredDirs: true,
    });
    for (const dir of ['build', 'dist', 'out', 'bin', 'obj', 'target', 'vendor', 'Temp']) {
      expect(matcher.ignores(`${dir}/`, true), dir).toBe(false);
    }
    expect(matcher.ignores('node_modules/', true)).toBe(false);
    expect(matcher.ignores('Library/', true)).toBe(false);
  });

  it('VCS 元数据 / OS 垃圾不受开关影响', async () => {
    const matcher = await loadIgnoreMatcher(workdir, {
      honorVcsIgnore: false,
      showIgnoredDirs: true,
    });
    expect(matcher.ignores('.git/', true)).toBe(true);
    expect(matcher.ignores('.git/config', false)).toBe(true);
    expect(matcher.ignores('.DS_Store', false)).toBe(true);
  });

  it('*.meta 仍只由 hideMetaFiles 决定,与开关正交', async () => {
    const revealKeepMeta = await loadIgnoreMatcher(workdir, {
      honorVcsIgnore: false,
      hideMetaFiles: false,
      showIgnoredDirs: true,
    });
    expect(revealKeepMeta.ignores('Foo.cs.meta', false)).toBe(false);

    const revealHideMeta = await loadIgnoreMatcher(workdir, {
      honorVcsIgnore: false,
      hideMetaFiles: true,
      showIgnoredDirs: true,
    });
    expect(revealHideMeta.ignores('Foo.cs.meta', false)).toBe(true);
  });

  it('两个开关值分别缓存(互不污染)', async () => {
    const off = await loadIgnoreMatcher(workdir, { honorVcsIgnore: false });
    const on = await loadIgnoreMatcher(workdir, { honorVcsIgnore: false, showIgnoredDirs: true });
    expect(on).not.toBe(off);
    // 再次取用各自命中自己的缓存条目。
    expect(await loadIgnoreMatcher(workdir, { honorVcsIgnore: false })).toBe(off);
    expect(
      await loadIgnoreMatcher(workdir, { honorVcsIgnore: false, showIgnoredDirs: true }),
    ).toBe(on);
  });
});
