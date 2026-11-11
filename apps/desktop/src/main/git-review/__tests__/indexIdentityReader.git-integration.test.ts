import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { runGit } from '../gitRunner';
import { readStagedIndexIdentity } from '../indexIdentityReader';

let repoPath: string;

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-index-id-', async (dir) => {
  await runGit(['init'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await runGit(['add', 'seed.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

beforeEach(async () => {
  repoPath = await repoTemplate.createCopy();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('readStagedIndexIdentity (#2460)', () => {
  it('binds the staged blob oid: swapping the index blob changes the record set', async () => {
    const file = path.join(repoPath, 'blob.bin');
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));
    await runGit(['add', 'blob.bin'], { cwd: repoPath });
    const before = await readStagedIndexIdentity(repoPath, ['blob.bin']);

    // 同尺寸不同字节换 blob,并把工作树字节还原 —— porcelain 与工作树内容
    // 指纹都看不出差异,只有 index oid 能区分(#2460 的攻击形态)。
    await fs.writeFile(file, Buffer.from([5, 6, 7, 8]));
    await runGit(['add', 'blob.bin'], { cwd: repoPath });
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));
    const after = await readStagedIndexIdentity(repoPath, ['blob.bin']);

    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^100644 0 [0-9a-f]{40,64}\tblob\.bin$/);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  it('re-adding identical bytes keeps the record set stable (no false churn)', async () => {
    const file = path.join(repoPath, 'blob.bin');
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));
    await runGit(['add', 'blob.bin'], { cwd: repoPath });
    const before = await readStagedIndexIdentity(repoPath, ['blob.bin']);

    await runGit(['add', 'blob.bin'], { cwd: repoPath });
    const after = await readStagedIndexIdentity(repoPath, ['blob.bin']);

    expect(after).toEqual(before);
  });

  it('records a staged deletion as an explicit absent marker', async () => {
    await runGit(['rm', 'seed.txt'], { cwd: repoPath });
    const records = await readStagedIndexIdentity(repoPath, ['seed.txt']);
    expect(records).toEqual(['absent\tseed.txt']);
  });

  it('expresses unmerged stages as one record per stage', async () => {
    // 构造冲突:两个分支各改 seed.txt 后合并。
    await runGit(['checkout', '-b', 'left'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'left\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'left'], { cwd: repoPath });
    await runGit(['checkout', '-b', 'right', 'HEAD~1'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'right\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'right'], { cwd: repoPath });
    await runGit(['merge', 'left'], { cwd: repoPath, allowedExitCodes: [0, 1] });

    const records = await readStagedIndexIdentity(repoPath, ['seed.txt']);
    expect(records).toHaveLength(3);
    const stages = records.map((record) => record.split(' ')[1]).sort();
    expect(stages).toEqual(['1', '2', '3']);
  });

  it('returns stable ordering regardless of input order and dedupes input paths', async () => {
    await fs.writeFile(path.join(repoPath, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(repoPath, 'b.txt'), 'b\n');
    await runGit(['add', 'a.txt', 'b.txt'], { cwd: repoPath });

    const forward = await readStagedIndexIdentity(repoPath, ['a.txt', 'b.txt']);
    const backward = await readStagedIndexIdentity(repoPath, ['b.txt', 'a.txt', 'b.txt']);
    expect(backward).toEqual(forward);
    expect(forward.map((record) => record.split('\t')[1])).toEqual(['a.txt', 'b.txt']);
  });

  it('fails closed when the repository cannot be read', async () => {
    await expect(
      readStagedIndexIdentity(path.join(repoPath, 'no-such-dir'), ['seed.txt']),
    ).rejects.toThrow();
  });

  // Windows 文件名不允许控制字符,该形态只在 POSIX 上可构造。
  it.skipIf(process.platform === 'win32')(
    'binds identity for paths containing newline instead of silently skipping them',
    async () => {
      const trickyName = 'a\nb.txt';
      await fs.writeFile(path.join(repoPath, trickyName), 'v1\n');
      await runGit(['add', '--', trickyName], { cwd: repoPath });
      const first = await readStagedIndexIdentity(repoPath, [trickyName]);
      expect(first).toHaveLength(1);
      expect(first[0]).not.toBe(`absent\t${trickyName}`);
      expect(first[0].endsWith(`\t${trickyName}`)).toBe(true);

      // #2460 攻击形态在换行路径上同样必须被身份变化捕获。
      await fs.writeFile(path.join(repoPath, trickyName), 'v2\n');
      await runGit(['add', '--', trickyName], { cwd: repoPath });
      const second = await readStagedIndexIdentity(repoPath, [trickyName]);
      expect(second).not.toEqual(first);
    },
  );

  it('merges results across pathspec batches identically to a single call', async () => {
    const names = Array.from({ length: 7 }, (_, i) => `batch-${i}.txt`);
    for (const name of names) {
      await fs.writeFile(path.join(repoPath, name), `${name}\n`);
    }
    await runGit(['add', '--', ...names], { cwd: repoPath });
    const queried = [...names, 'batch-missing.txt'];

    const single = await readStagedIndexIdentity(repoPath, queried);
    const batched = await readStagedIndexIdentity(repoPath, queried, {
      maxBatchPaths: 2,
      maxBatchPathspecBytes: 64,
    });
    expect(batched).toEqual(single);
    expect(batched).toHaveLength(queried.length);
    expect(batched).toContain('absent\tbatch-missing.txt');
  });
});
