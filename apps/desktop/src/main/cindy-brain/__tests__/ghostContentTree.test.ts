/**
 * ghostContentTree.test.ts —— 插件内容目录判据(唯一实现)的单测。
 *
 * 这个模块存在的理由就是"同一判据别再散落多处",所以判据本身的回归点集中钉在
 * 这里:类型判定一律 lstat、路径逐段解析、点开头与非普通条目的策略组合。
 * 规则 23:全部路径在 os.tmpdir 下,收尾清理。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyGhostDirEntry,
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
  hashGhostContentBuffers,
  hashGhostContentFiles,
  resolveGhostContentPath,
  resolveGhostContentPathSync,
} from '../ghostContentTree';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-content-tree-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

/** 建目录链接;该环境无权限时返回 false 让用例跳过(判定逻辑与其他平台同源)。 */
async function tryLinkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.promises.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** 建文件链接；Windows 无权限时返回 false。 */
async function tryLinkFile(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.promises.symlink(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

async function mockStaleLeafPathStatAfterMutation(file: string): Promise<{
  markMutated: () => void;
  restore: () => void;
}> {
  // GitHub Windows runner 上，句柄关闭后按路径 lstat 仍可能短暂返回 mutation 前的状态。
  const initialStat = await fs.promises.lstat(file, { bigint: true });
  const realLstat = fs.promises.lstat;
  let mutated = false;
  const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
    candidate: fs.PathLike,
    options?: fs.StatOptions,
  ) => {
    if (mutated && path.resolve(String(candidate)) === path.resolve(file)) {
      return initialStat;
    }
    return (realLstat as (...args: unknown[]) => Promise<fs.BigIntStats>)(candidate, options);
  }) as typeof fs.promises.lstat);
  return {
    markMutated: () => {
      mutated = true;
    },
    restore: () => lstatSpy.mockRestore(),
  };
}

async function writeDurably(file: string, bytes: Buffer | string, flags: string): Promise<void> {
  const handle = await fs.promises.open(file, flags);
  try {
    if (flags === 'r+') await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function shiftDirectoryTimes(stat: fs.BigIntStats): fs.BigIntStats {
  return new Proxy(stat, {
    get(target, key) {
      if (key === 'mtimeNs' || key === 'ctimeNs') return target[key] + 1n;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('classifyGhostDirEntry', () => {
  it('separates regular files, real directories and links', async () => {
    const file = path.join(workDir, 'a.txt');
    const dir = path.join(workDir, 'sub');
    const link = path.join(workDir, 'linked');
    await fs.promises.writeFile(file, 'bytes');
    await fs.promises.mkdir(dir);

    expect(await classifyGhostDirEntry(file)).toBe('file');
    expect(await classifyGhostDirEntry(dir)).toBe('directory');
    expect(classifyGhostDirEntrySync(file)).toBe('file');
    expect(classifyGhostDirEntrySync(dir)).toBe('directory');

    if (!(await tryLinkDir(dir, link))) return;
    // 关键:链接指向真目录,但判据看 lstat,所以是 link 而不是 directory。
    expect(await classifyGhostDirEntry(link)).toBe('link');
    expect(classifyGhostDirEntrySync(link)).toBe('link');
  });
});

describe('resolveGhostContentPath', () => {
  it('rejects a link in an intermediate segment instead of silently reading outside', async () => {
    // 回归点:只 lstat 最终段是不够的 —— 中间段被换成链接时 OS 会静默穿透,对最终段
    // lstat 报的是"真目录、非链接",于是字节从插件目录之外取。
    const base = path.join(workDir, 'plugin');
    const outside = path.join(workDir, 'outside');
    await fs.promises.mkdir(path.join(base, 'skills', 'demo'), { recursive: true });
    await fs.promises.mkdir(path.join(outside, 'demo'), { recursive: true });

    await expect(
      resolveGhostContentPath(base, 'skills/demo', { expect: 'directory', label: 'x' }),
    ).resolves.toBe(path.join(base, 'skills', 'demo'));

    await fs.promises.rm(path.join(base, 'skills'), { recursive: true, force: true });
    if (!(await tryLinkDir(outside, path.join(base, 'skills')))) return;

    await expect(
      resolveGhostContentPath(base, 'skills/demo', { expect: 'directory', label: 'x' }),
    ).rejects.toThrow(/path segment is a link/);
    expect(() =>
      resolveGhostContentPathSync(base, 'skills/demo', { expect: 'directory', label: 'x' }),
    ).toThrow(/path segment is a link/);
  });

  it('enforces the expected kind of the final segment', async () => {
    await fs.promises.mkdir(path.join(workDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(workDir, 'assets', 'icon.png'), 'png');

    await expect(
      resolveGhostContentPath(workDir, 'assets/icon.png', { expect: 'file', label: 'icon' }),
    ).resolves.toBe(path.join(workDir, 'assets', 'icon.png'));
    await expect(
      resolveGhostContentPath(workDir, 'assets', { expect: 'file', label: 'icon' }),
    ).rejects.toThrow(/not a regular file/);
    await expect(
      resolveGhostContentPath(workDir, 'assets/icon.png', {
        expect: 'directory',
        label: 'icon',
      }),
    ).rejects.toThrow(/not a directory/);
  });
});

describe('collectGhostContentFiles', () => {
  it('rejects a linked content root before following it', async () => {
    const root = path.join(workDir, 'plugin');
    const outside = path.join(workDir, 'outside');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'main.js'), '// outside');
    if (!(await tryLinkDir(outside, root))) return;

    await expect(
      collectGhostContentFiles(root, {
        dotEntries: 'include',
        nonRegular: 'throw',
        label: 'test',
      }),
    ).rejects.toThrow(/ghost content root is not a real directory/);
  });

  it('includes dot entries for skill content and rejects links there', async () => {
    const dir = path.join(workDir, 'skill');
    await fs.promises.mkdir(path.join(dir, 'refs'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'SKILL.md'), 'md');
    await fs.promises.writeFile(path.join(dir, '.helper'), 'dot bytes');
    await fs.promises.writeFile(path.join(dir, 'refs', 'a.md'), 'a');

    const tree = await collectGhostContentFiles(dir, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'approved skill',
    });
    // 技能目录里的点开头文件同样算内容:技能指令可以引用它。
    expect(tree.files).toEqual(['.helper', 'SKILL.md', 'refs/a.md']);
    expect(tree.hasNonRegularEntry).toBe(false);

    if (!(await tryLinkDir(path.join(workDir, 'skill'), path.join(dir, 'loop')))) return;
    await expect(
      collectGhostContentFiles(dir, {
        dotEntries: 'include',
        nonRegular: 'throw',
        label: 'approved skill',
      }),
    ).rejects.toThrow(/rejects link entry/);
  });

  it('keeps dot entries out of the content hash but still type-checks them', async () => {
    // 回归点:上一版对点开头条目直接 continue,于是名为 `.x` 的链接既不进指纹、
    // 也不翻状态位 —— 安装目录被塞进链接却判成"与种子逐字节相同"。
    const dir = path.join(workDir, 'installed');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
    await fs.promises.writeFile(path.join(dir, '.disabled'), '');

    const before = await collectGhostContentFiles(dir, {
      dotEntries: 'skip',
      nonRegular: 'flag',
      label: 'seed',
    });
    expect(before.files).toEqual(['main.js']);
    expect(before.hasNonRegularEntry).toBe(false);

    if (!(await tryLinkDir(workDir, path.join(dir, '.sneaky')))) return;
    const after = await collectGhostContentFiles(dir, {
      dotEntries: 'skip',
      nonRegular: 'flag',
      label: 'seed',
    });
    expect(after.files).toEqual(['main.js']);
    expect(after.hasNonRegularEntry).toBe(true);
    // 内容哈希不受影响(链接没有内容),判定靠独立的类型状态位。
    expect(await hashGhostContentFiles(dir, after.files)).toBe(
      await hashGhostContentFiles(dir, before.files),
    );
  });
});

describe('hashGhostContentFiles', () => {
  it('hashes path + bytes so identical trees match and any byte change does not', async () => {
    const a = path.join(workDir, 'a');
    const b = path.join(workDir, 'b');
    for (const dir of [a, b]) {
      await fs.promises.mkdir(path.join(dir, 'nested'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'main.js'), '// brain');
      await fs.promises.writeFile(path.join(dir, 'nested', 'x.txt'), 'x');
    }
    const options = { dotEntries: 'skip', nonRegular: 'throw', label: 't' } as const;
    const treeA = await collectGhostContentFiles(a, options);
    const treeB = await collectGhostContentFiles(b, options);
    expect(await hashGhostContentFiles(a, treeA.files)).toBe(
      await hashGhostContentFiles(b, treeB.files),
    );

    await fs.promises.writeFile(path.join(b, 'nested', 'x.txt'), 'y');
    expect(await hashGhostContentFiles(a, treeA.files)).not.toBe(
      await hashGhostContentFiles(b, treeB.files),
    );
  });

  it('uses unambiguous framing when file bytes contain NUL separators', async () => {
    const oneFile = path.join(workDir, 'one-file');
    const twoFiles = path.join(workDir, 'two-files');
    await fs.promises.mkdir(oneFile);
    await fs.promises.mkdir(twoFiles);
    await fs.promises.writeFile(path.join(oneFile, 'a'), Buffer.from('x\0b\0y'));
    await fs.promises.writeFile(path.join(twoFiles, 'a'), 'x');
    await fs.promises.writeFile(path.join(twoFiles, 'b'), 'y');

    const options = { dotEntries: 'include', nonRegular: 'throw', label: 't' } as const;
    const oneTree = await collectGhostContentFiles(oneFile, options);
    const twoTree = await collectGhostContentFiles(twoFiles, options);

    expect(oneTree.files).toEqual(['a']);
    expect(twoTree.files).toEqual(['a', 'b']);
    expect(await hashGhostContentFiles(oneFile, oneTree.files)).not.toBe(
      await hashGhostContentFiles(twoFiles, twoTree.files),
    );
  });

  it('rejects an intermediate directory replaced by an outside link after collection', async () => {
    const root = path.join(workDir, 'plugin');
    const outside = path.join(workDir, 'outside');
    await fs.promises.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'nested', 'x.txt'), 'inside');
    await fs.promises.writeFile(path.join(outside, 'x.txt'), 'outside');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });

    await fs.promises.rm(path.join(root, 'nested'), { recursive: true, force: true });
    if (!(await tryLinkDir(outside, path.join(root, 'nested')))) return;

    await expect(hashGhostContentFiles(root, tree.files, tree.rootIdentity)).rejects.toThrow(
      /root changed|escaped its root|changed into a link/,
    );
  });

  it('rejects an intermediate directory replaced by a link within the content root', async () => {
    const root = path.join(workDir, 'plugin');
    const alternate = path.join(root, 'alternate');
    await fs.promises.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.promises.mkdir(alternate, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'nested', 'x.txt'), 'inside');
    await fs.promises.writeFile(path.join(alternate, 'x.txt'), 'alternate');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });

    await fs.promises.rm(path.join(root, 'nested'), { recursive: true, force: true });
    if (!(await tryLinkDir(alternate, path.join(root, 'nested')))) return;

    await expect(hashGhostContentFiles(root, tree.files, tree.rootIdentity)).rejects.toThrow(
      /root changed|ancestor changed into a link/,
    );
  });

  it('rejects a leaf file replaced by a link after collection', async () => {
    const root = path.join(workDir, 'plugin');
    const outside = path.join(workDir, 'outside.txt');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'main.js'), 'inside');
    await fs.promises.writeFile(outside, 'outside');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });

    await fs.promises.rm(path.join(root, 'main.js'));
    if (!(await tryLinkFile(outside, path.join(root, 'main.js')))) return;

    await expect(hashGhostContentFiles(root, tree.files, tree.rootIdentity)).rejects.toThrow();
  });

  it('rejects a same-inode leaf file rewritten while its bytes are being hashed', async () => {
    const root = path.join(workDir, 'plugin');
    const file = path.join(root, 'main.js');
    const originalBytes = Buffer.from('old-prefix|old-suffix');
    const replacementBytes = Buffer.from('new-prefix|new-suffix');
    expect(replacementBytes.byteLength).toBe(originalBytes.byteLength);
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(file, originalBytes);
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });
    const canonicalFile = path.join(tree.rootIdentity.realPath, 'main.js');

    const splitAt = 'old-prefix|'.length;
    const stalePathStat = await mockStaleLeafPathStatAfterMutation(canonicalFile);
    const realOpen = fs.promises.open;
    let targetOpenCount = 0;
    let mutationRan = false;
    let staleHandleStat: fs.BigIntStats | undefined;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) !== canonicalFile) return handle;
      if (typeof args[1] !== 'number') return handle;
      targetOpenCount += 1;
      const mutateDuringRead = targetOpenCount === 1;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async () => {
              staleHandleStat ??= await handle.stat({ bigint: true });
              return staleHandleStat;
            };
          }
          if (key === 'createReadStream' && mutateDuringRead) {
            return () => Readable.from((async function*() {
              const first = Buffer.alloc(splitAt);
              const firstRead = await handle.read(first, 0, first.byteLength, 0);
              yield first.subarray(0, firstRead.bytesRead);

              await writeDurably(canonicalFile, replacementBytes, 'r+');
              const changedAt = new Date(Date.now() + 5_000);
              await fs.promises.utimes(canonicalFile, changedAt, changedAt);
              await expect(fs.promises.readFile(canonicalFile)).resolves.toEqual(replacementBytes);
              stalePathStat.markMutated();
              mutationRan = true;

              const rest = Buffer.alloc(replacementBytes.byteLength - splitAt);
              const restRead = await handle.read(rest, 0, rest.byteLength, splitAt);
              yield rest.subarray(0, restRead.bytesRead);
            })());
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(
        hashGhostContentFiles(root, tree.files, tree.rootIdentity),
      ).rejects.toThrow(/entry changed while reading/);
    } finally {
      openSpy.mockRestore();
      stalePathStat.restore();
    }
    expect(targetOpenCount).toBe(2);
    expect(mutationRan).toBe(true);
  });

  it('rejects a leaf file renamed away and replaced while its opened bytes are being hashed', async () => {
    const root = path.join(workDir, 'plugin');
    const file = path.join(root, 'main.js');
    const stagedFile = path.join(workDir, 'replacement.js');
    const originalBytes = Buffer.from('approved bytes');
    const replacementBytes = Buffer.from('replacement bytes');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(file, originalBytes);
    await writeDurably(stagedFile, replacementBytes, 'wx');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });
    const canonicalFile = path.join(tree.rootIdentity.realPath, 'main.js');
    const canonicalDetachedFile = path.join(tree.rootIdentity.realPath, 'detached.js');

    const stalePathStat = await mockStaleLeafPathStatAfterMutation(canonicalFile);
    const realOpen = fs.promises.open;
    let targetOpenCount = 0;
    let mutationRan = false;
    let staleHandleStat: fs.BigIntStats | undefined;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) !== canonicalFile) return handle;
      targetOpenCount += 1;
      const mutateDuringRead = targetOpenCount === 1;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async () => {
              staleHandleStat ??= await handle.stat({ bigint: true });
              return staleHandleStat;
            };
          }
          if (key === 'createReadStream' && mutateDuringRead) {
            return () => Readable.from((async function*() {
              const bytes = Buffer.alloc(originalBytes.byteLength);
              const read = await handle.read(bytes, 0, bytes.byteLength, 0);
              await fs.promises.rename(canonicalFile, canonicalDetachedFile);
              await fs.promises.rename(stagedFile, canonicalFile);
              await expect(fs.promises.readFile(canonicalFile)).resolves.toEqual(replacementBytes);
              stalePathStat.markMutated();
              mutationRan = true;
              yield bytes.subarray(0, read.bytesRead);
            })());
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(
        hashGhostContentFiles(root, tree.files, tree.rootIdentity),
      ).rejects.toThrow(/entry (?:changed|path changed) while reading/);
    } finally {
      openSpy.mockRestore();
      stalePathStat.restore();
    }
    expect(targetOpenCount).toBe(2);
    expect(mutationRan).toBe(true);
  });

  it('rejects root generation drift even when dev and ino are reused', async () => {
    const root = path.join(workDir, 'plugin');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'main.js'), 'stable bytes');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });

    const realStat = fs.promises.stat;
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      candidate: fs.PathLike,
    ) => {
      const stat = await realStat(candidate, { bigint: true });
      if (stat.dev === tree.rootIdentity.dev && stat.ino === tree.rootIdentity.ino) {
        return shiftDirectoryTimes(stat);
      }
      return stat;
    }) as typeof fs.promises.stat);
    try {
      await expect(
        hashGhostContentFiles(root, tree.files, tree.rootIdentity),
      ).rejects.toThrow(/root changed/);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('rejects ancestor generation drift even when dev and ino are unchanged', async () => {
    const root = path.join(workDir, 'plugin');
    const nested = path.join(root, 'nested');
    await fs.promises.mkdir(nested, { recursive: true });
    await fs.promises.writeFile(path.join(nested, 'main.js'), 'stable bytes');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });
    const canonicalNested = path.join(tree.rootIdentity.realPath, 'nested');
    const nestedIdentity = await fs.promises.lstat(canonicalNested, { bigint: true });

    const realLstat = fs.promises.lstat;
    let nestedLstatCount = 0;
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
      candidate: fs.PathLike,
    ) => {
      const stat = await realLstat(candidate, { bigint: true });
      if (stat.dev === nestedIdentity.dev && stat.ino === nestedIdentity.ino) {
        nestedLstatCount += 1;
        return nestedLstatCount === 1 ? stat : shiftDirectoryTimes(stat);
      }
      return stat;
    }) as typeof fs.promises.lstat);
    try {
      await expect(
        hashGhostContentFiles(root, tree.files, tree.rootIdentity),
      ).rejects.toThrow(/ancestor changed/);
    } finally {
      lstatSpy.mockRestore();
    }
    expect(nestedLstatCount).toBe(2);
  });

  it('rejects the content root being replaced between collection and hashing', async () => {
    const root = path.join(workDir, 'plugin');
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'main.js'), 'inside');
    const tree = await collectGhostContentFiles(root, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'test',
    });

    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, 'main.js'), 'replacement');

    await expect(hashGhostContentFiles(root, tree.files, tree.rootIdentity)).rejects.toThrow(
      /root changed/,
    );
  });
});

describe('hashGhostContentBuffers', () => {
  it('与 hashGhostContentFiles 对同一棵文件树逐字节等价(装入基线与快照对账共用判据)', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-buf-hash-'));
    try {
      await fs.promises.mkdir(path.join(root, 'nested'), { recursive: true });
      const tree: Record<string, string> = {
        'SKILL.md': '---\nname: x\n---\nbody',
        '.hidden': 'dot files count',
        'nested/helper.txt': 'helper',
      };
      for (const [rel, content] of Object.entries(tree)) {
        await fs.promises.writeFile(path.join(root, ...rel.split('/')), content);
      }
      const collected = await collectGhostContentFiles(root, {
        dotEntries: 'include',
        nonRegular: 'throw',
        label: 'test',
      });
      const fromDisk = await hashGhostContentFiles(root, collected.files, collected.rootIdentity);
      const fromMemory = hashGhostContentBuffers(
        Object.entries(tree).map(([p2, c]) => ({ path: p2, bytes: Buffer.from(c) })),
      );
      expect(fromMemory).toBe(fromDisk);
      // 内容差一个字节即不同。
      const drifted = hashGhostContentBuffers(
        Object.entries({ ...tree, 'SKILL.md': tree['SKILL.md'] + '!' }).map(([p2, c]) => ({
          path: p2,
          bytes: Buffer.from(c),
        })),
      );
      expect(drifted).not.toBe(fromDisk);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
