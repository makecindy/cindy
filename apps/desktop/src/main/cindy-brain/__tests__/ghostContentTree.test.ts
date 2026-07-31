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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyGhostDirEntry,
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
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
    await fs.promises.symlink(
      target,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch {
    return false;
  }
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
});
