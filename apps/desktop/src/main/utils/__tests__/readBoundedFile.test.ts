/**
 * readBoundedFileNoFollow — 不可信目录单文件的安全读取。
 * 重点:符号链接一律拒(POSIX 走 O_NOFOLLOW,无该 flag 的平台走
 * lstat+dev/ino 回退闸),超限/非普通文件返回 null。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollow,
} from '../readBoundedFile';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-bounded-read-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('readBoundedFileNoFollow', () => {
  it('普通文件按实际字节返回,超限返回 null', async () => {
    const small = path.join(workDir, 'small.json');
    await fs.promises.writeFile(small, '{"ok":true}');
    expect((await readBoundedFileNoFollow(small, 1024))?.toString('utf8')).toBe('{"ok":true}');

    const big = path.join(workDir, 'big.json');
    await fs.promises.writeFile(big, 'x'.repeat(GHOST_MANIFEST_MAX_BYTES + 1));
    expect(await readBoundedFileNoFollow(big, GHOST_MANIFEST_MAX_BYTES)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('POSIX:符号链接在 open 处被 O_NOFOLLOW 拒绝', async () => {
    const target = path.join(workDir, 'target.json');
    await fs.promises.writeFile(target, '{"ok":true}');
    const link = path.join(workDir, 'link.json');
    await fs.promises.symlink(target, link);
    await expect(readBoundedFileNoFollow(link, 1024)).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    '无 O_NOFOLLOW 的平台:lstat 回退闸同样拒符号链接,目标合法也不放行',
    async () => {
      const target = path.join(workDir, 'target.json');
      await fs.promises.writeFile(target, '{"ok":true}');
      const link = path.join(workDir, 'link.json');
      await fs.promises.symlink(target, link);
      // 注入 null 模拟 Windows:open 会跟随链接,回退闸必须把它拦下来。
      expect(await readBoundedFileNoFollow(link, 1024, null)).toBeNull();
    },
  );

  it('无 O_NOFOLLOW 的平台:普通文件不被回退闸误伤', async () => {
    const file = path.join(workDir, 'plain.json');
    await fs.promises.writeFile(file, '{"ok":1}');
    expect((await readBoundedFileNoFollow(file, 1024, null))?.toString('utf8')).toBe('{"ok":1}');
  });
});
