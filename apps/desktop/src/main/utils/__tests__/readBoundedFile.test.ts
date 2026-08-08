/**
 * readBoundedFileNoFollow — 不可信目录单文件的安全读取。
 * 重点:符号链接一律拒(POSIX 走 O_NOFOLLOW,无该 flag 的平台走
 * lstat+dev/ino 回退闸),超限/非普通文件返回 null。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BoundedFileReadChangedError,
  BoundedFileReadUncertainError,
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollow,
  readBoundedFileNoFollowSync,
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

  it('rejectHardLinks:拒绝已有硬链接的文件', async () => {
    const original = path.join(workDir, 'outside-secret.png');
    const linked = path.join(workDir, 'market-icon.png');
    await fs.promises.writeFile(original, 'PRIVATE');
    await fs.promises.link(original, linked);

    expect(await readBoundedFileNoFollow(linked, 1024, { rejectHardLinks: true })).toBeNull();
  });

  it('rejectHardLinks:读取后链接计数变化时按内容变化拒绝', async () => {
    const file = path.join(workDir, 'linked-during-read.png');
    await fs.promises.writeFile(file, 'SAFE');
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      const realStat = handle.stat.bind(handle);
      let statCalls = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async (options?: fs.StatOptions) => {
              const stat = (await realStat(options as never)) as unknown as fs.BigIntStats;
              statCalls += 1;
              if (statCalls === 1) return stat;
              return new Proxy(stat, {
                get(statTarget, statKey) {
                  if (statKey === 'nlink') return 2n;
                  const value = Reflect.get(statTarget, statKey);
                  return typeof value === 'function' ? value.bind(statTarget) : value;
                },
              }) as fs.BigIntStats;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(
        readBoundedFileNoFollow(file, 1024, {
          rejectHardLinks: true,
          verifyContentStability: true,
        }),
      ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
    } finally {
      openSpy.mockRestore();
    }
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
      expect(await readBoundedFileNoFollow(link, 1024, { noFollowFlag: null })).toBeNull();
    },
  );

  it('无 O_NOFOLLOW 的平台:普通文件不被回退闸误伤', async () => {
    const file = path.join(workDir, 'plain.json');
    await fs.promises.writeFile(file, '{"ok":1}');
    expect(
      (await readBoundedFileNoFollow(file, 1024, { noFollowFlag: null }))?.toString('utf8'),
    ).toBe('{"ok":1}');
  });

  it('无 O_NOFOLLOW 的平台:lstat 报告符号链接时拒绝,不依赖宿主 symlink 权限', async () => {
    const file = path.join(workDir, 'link-shaped.json');
    await fs.promises.writeFile(file, '{"ok":1}');
    const realStat = await fs.promises.lstat(file, { bigint: true });
    const linkStat = new Proxy(realStat, {
      get(target, key) {
        if (key === 'isSymbolicLink') return () => true;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockResolvedValue(linkStat as never);
    try {
      expect(await readBoundedFileNoFollow(file, 1024, { noFollowFlag: null })).toBeNull();
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'containWithin:中间目录被换成根外链接时拒绝(最终分量是普通文件,O_NOFOLLOW 拦不住)',
    async () => {
      const realWork = await fs.promises.realpath(workDir);
      const root = path.join(realWork, 'root');
      const outsideSub = path.join(realWork, 'outside', 'sub');
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.mkdir(outsideSub, { recursive: true });
      await fs.promises.writeFile(path.join(outsideSub, 'ghost.json'), '{"ok":1}');
      await fs.promises.symlink(outsideSub, path.join(root, 'linkdir'));

      expect(
        await readBoundedFileNoFollow(path.join(root, 'linkdir', 'ghost.json'), 1024, {
          containWithin: root,
        }),
      ).toBeNull();
      expect(
        readBoundedFileNoFollowSync(path.join(root, 'linkdir', 'ghost.json'), 1024, {
          containWithin: root,
        }),
      ).toBeNull();

      // 根内正常文件不被复核误伤(含 root 自带链接祖先的情形:两侧都走 realpath)。
      await fs.promises.writeFile(path.join(root, 'plain.json'), '{"ok":2}');
      expect(
        (
          await readBoundedFileNoFollow(path.join(root, 'plain.json'), 1024, {
            containWithin: root,
          })
        )?.toString('utf8'),
      ).toBe('{"ok":2}');
      expect(
        readBoundedFileNoFollowSync(path.join(root, 'plain.json'), 1024, {
          containWithin: root,
        })?.toString('utf8'),
      ).toBe('{"ok":2}');
    },
  );

  it.runIf(process.platform !== 'win32')('nonBlocking: FIFO 不阻塞并被拒绝', async () => {
    const fifo = path.join(workDir, 'icon');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return;
    const started = Date.now();
    await expect(readBoundedFileNoFollow(fifo, 1024, { nonBlocking: true })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('根内复核暂时失败时报告不确定读取,不伪装成缺失', async () => {
    const file = path.join(workDir, 'uncertain.json');
    await fs.promises.writeFile(file, '{"ok":true}');
    const statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    try {
      const error = await readBoundedFileNoFollow(file, 1024, { containWithin: workDir }).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(BoundedFileReadUncertainError);
      expect(error).toMatchObject({ code: 'EACCES' });
    } finally {
      statSpy.mockRestore();
    }
  });

  it('网络盘短读:单次 read 未填满时循环读满已校验长度', async () => {
    const file = path.join(workDir, 'short.json');
    const payload = `{"key":"${'a'.repeat(64)}"}`;
    await fs.promises.writeFile(file, payload);
    // 模拟 FUSE/网络盘:每次 read 最多返回 7 字节。单次读会把合法文件截断。
    const realOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'read') {
            return (buffer: Buffer, offset: number, length: number, position: number) =>
              realRead(buffer, offset, Math.min(length, 7), position);
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      const bytes = await readBoundedFileNoFollow(file, 1024);
      expect(bytes?.toString('utf8')).toBe(payload);
    } finally {
      spy.mockRestore();
    }
  });

  it('开启内容稳定性校验时,读取期间版本变化返回可重试错误', async () => {
    const file = path.join(workDir, 'changed.json');
    await fs.promises.writeFile(file, '{"ok":true}');
    const realOpen = fs.promises.open;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      const realStat = handle.stat.bind(handle);
      let statCalls = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async (options?: fs.StatOptions) => {
              const stat = (await realStat(options as never)) as unknown as fs.BigIntStats;
              statCalls += 1;
              if (statCalls !== 2) return stat;
              return new Proxy(stat, {
                get(statTarget, statKey) {
                  if (statKey === 'mtimeNs') return statTarget.mtimeNs + 1n;
                  const value = Reflect.get(statTarget, statKey);
                  return typeof value === 'function' ? value.bind(statTarget) : value;
                },
              }) as fs.BigIntStats;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(
        readBoundedFileNoFollow(file, 1024, { verifyContentStability: true }),
      ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('开启内容稳定性校验时,同 stat 的同长度改写会在复读时返回可重试错误', async () => {
    const file = path.join(workDir, 'same-stat-changed.json');
    await fs.promises.writeFile(file, 'AAAA');
    const stableStat = await fs.promises.stat(file, { bigint: true });
    const realOpen = fs.promises.open;
    let rewritten = false;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') return async () => stableStat;
          if (key === 'read') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              const result = await realRead(buffer, offset, length, position);
              if (!rewritten) {
                await fs.promises.writeFile(file, 'BBBB');
                rewritten = true;
              }
              return result;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.promises.open);
    try {
      await expect(
        readBoundedFileNoFollow(file, 1024, { verifyContentStability: true }),
      ).rejects.toBeInstanceOf(BoundedFileReadChangedError);
      expect(rewritten).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')(
    '回退闸:dev/ino 为 0(网络盘/无标识 FS)时拒绝,不退化成只看 isSymbolicLink',
    async () => {
      const file = path.join(workDir, 'zero-ino.json');
      await fs.promises.writeFile(file, '{"ok":1}');
      // 模拟 SMB/FUSE:句柄 stat 与 lstat 都拿不到可信 dev/ino(填 0)。没有 reject-0
      // 守卫时 0n===0n 恒真,回退闸退化成"证明句柄=路径目录项"永真,只剩
      // isSymbolicLink 一条。此时应拒绝(无法证明),而不是照读。走 noFollowFlag:null。
      const zero = (st: fs.BigIntStats): fs.BigIntStats =>
        new Proxy(st, {
          get(target, key) {
            if (key === 'dev' || key === 'ino') return 0n;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const realOpen = fs.promises.open;
      const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        const handle = await realOpen(...args);
        const realStat = handle.stat.bind(handle);
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'stat') {
              return async (opts?: fs.StatOptions) =>
                zero((await realStat(opts as never)) as unknown as fs.BigIntStats);
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }) as typeof fs.promises.open);
      const realLstat = fs.promises.lstat;
      const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
        p: fs.PathLike,
        opts?: fs.StatOptions,
      ) => {
        const st = (await (realLstat as (...a: unknown[]) => Promise<fs.BigIntStats>)(
          p,
          opts,
        )) as fs.BigIntStats;
        return zero(st);
      }) as typeof fs.promises.lstat);
      try {
        expect(await readBoundedFileNoFollow(file, 1024, { noFollowFlag: null })).toBeNull();
      } finally {
        openSpy.mockRestore();
        lstatSpy.mockRestore();
      }
    },
  );
});

describe('readBoundedFileNoFollowSync', () => {
  it('限量与回退闸语义和异步变体一致', async () => {
    const file = path.join(workDir, 'plain.json');
    await fs.promises.writeFile(file, '{"ok":1}');
    expect(readBoundedFileNoFollowSync(file, 1024)?.toString('utf8')).toBe('{"ok":1}');
    expect(readBoundedFileNoFollowSync(file, 1024, { noFollowFlag: null })?.toString('utf8')).toBe(
      '{"ok":1}',
    );

    const big = path.join(workDir, 'big.json');
    await fs.promises.writeFile(big, 'x'.repeat(2048));
    expect(readBoundedFileNoFollowSync(big, 1024)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')(
    '符号链接:O_NOFOLLOW 拒于 open,回退闸拒于 lstat',
    async () => {
      const target = path.join(workDir, 'target.json');
      await fs.promises.writeFile(target, '{"ok":true}');
      const link = path.join(workDir, 'link.json');
      await fs.promises.symlink(target, link);
      expect(() => readBoundedFileNoFollowSync(link, 1024)).toThrow();
      expect(readBoundedFileNoFollowSync(link, 1024, { noFollowFlag: null })).toBeNull();
    },
  );
});
