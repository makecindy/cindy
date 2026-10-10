/**
 * listAllFilesWalk —— 无 rg 的纯 JS fallback 清单。
 * 覆盖:gitignore + BUILTIN_IGNORE 过滤、隐藏文件包含、cap 截断、symlink 跳过。
 */

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listAllFilesWalk } from '../listAllFiles.js';
import { __clearCacheForTesting, loadIgnoreMatcher } from '../ignore.js';

describe('listAllFilesWalk', () => {
  let workdir: string;

  beforeEach(async () => {
    __clearCacheForTesting();
    workdir = await mkdtemp(path.join(os.tmpdir(), 'walk-test-'));
    await writeFile(path.join(workdir, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8');
    await mkdir(path.join(workdir, 'src', 'deep'), { recursive: true });
    await mkdir(path.join(workdir, 'ignored-dir'));
    await mkdir(path.join(workdir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workdir, 'README.md'), '# hi\n', 'utf8');
    await writeFile(path.join(workdir, '.hidden.txt'), 'dot\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'a.ts'), 'a\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'deep', 'b.ts'), 'b\n', 'utf8');
    await writeFile(path.join(workdir, 'src', 'noise.log'), 'log\n', 'utf8');
    await writeFile(path.join(workdir, 'ignored-dir', 'x.txt'), 'x\n', 'utf8');
    await writeFile(path.join(workdir, 'node_modules', 'pkg', 'index.js'), 'm\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('honors gitignore + builtin ignore, includes dotfiles, recurses', async () => {
    const res = await listAllFilesWalk({ workdir });
    expect(res.truncated).toBe(false);
    expect(res.files).toEqual(
      expect.arrayContaining(['README.md', '.hidden.txt', 'src/a.ts', 'src/deep/b.ts']),
    );
    // .gitignore:目录与 glob 都生效;BUILTIN_IGNORE:node_modules 永不遍历。
    expect(res.files.some((f) => f.startsWith('ignored-dir/'))).toBe(false);
    expect(res.files).not.toContain('src/noise.log');
    expect(res.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('caps and marks truncated', async () => {
    const res = await listAllFilesWalk({ workdir, cap: 2 });
    expect(res.truncated).toBe(true);
    expect(res.files.length).toBe(2);
  });

  it('skips symlinks (no follow, no loops)', async () => {
    // 指回 workdir 自身的目录链接:follow 会造环,必须跳过。
    // 'junction':Windows 无特权也能建目录链接(POSIX 下该参数被忽略,行为不变)。
    await symlink(workdir, path.join(workdir, 'src', 'loop'), 'junction');
    const res = await listAllFilesWalk({ workdir });
    expect(res.truncated).toBe(false);
    expect(res.files.some((f) => f.includes('loop'))).toBe(false);
  });

  /**
   * 决策测试(不是遗漏):文件名筛选**不跟随**文件树的「显示被忽略的目录」开关。
   * 同一份工作区里两侧故意给出不同答案:文件树(loadIgnoreMatcher)在开关打开后
   * 放行 build/,而筛选清单仍然不含它。
   *
   * 为什么不能只改 fallback:rg 后端无法"只放行构建产物"而保留用户自己的
   * .gitignore 规则,单边跟随会让筛选结果随「机器上装没装 rg」而变(更细的理据
   * 见 listAllFiles.ts 的 fallback 注释)。要改这条语义必须两个后端一起改,这条
   * 测试就是那道闸。
   */
  it('不跟随「显示被忽略的目录」:树放行 build/,筛选清单仍然不含它', async () => {
    await mkdir(path.join(workdir, 'build'));
    await writeFile(path.join(workdir, 'build', 'bundle.js'), 'x\n', 'utf8');

    const treeMatcher = await loadIgnoreMatcher(workdir, {
      honorVcsIgnore: false,
      showIgnoredDirs: true,
    });
    expect(treeMatcher.ignores('build/', true)).toBe(false); // 树:看得见

    const res = await listAllFilesWalk({ workdir });
    expect(res.files.some((f) => f.startsWith('build/'))).toBe(false); // 筛选:找不到
  });
});
