/**
 * 「登出没清干净」的持久重试队列。
 *
 * 隐私承诺是「登出后本机不留上一个账号的远程聊天缓存」;删除可能失败(文件锁 / 权限),
 * 而登出不能因此卡住 —— 所以失败必须留下**可重试的持久痕迹**,而不是一行日志
 * (review: codex P1)。这里守三件事:入队去重与计数、消化后条目消失、
 * 以及队列文件被改写成任意路径时不照着删(它是普通 JSON,不能当授权)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let userData: string;

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : userData) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  drainPurgeQueue,
  enqueuePurge,
  isPurgableRoot,
  __testing,
} from '../mirrorCachePurgeQueue';

function queueFile(): string {
  return path.join(userData, __testing.queueFileName);
}

/** 造一个 owner 作用域下的缓存目录(带内容)。 */
async function makeOwnerCache(ownerKey: string): Promise<string> {
  const root = path.join(userData, 'owners', ownerKey, 'device-link-mirror-cache');
  await fsp.mkdir(path.join(root, 'messages'), { recursive: true });
  await fsp.writeFile(path.join(root, 'messages', 'a.json'), '{}', 'utf8');
  return root;
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-purge-queue-'));
  __testing.resetMemoryQueue();
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  __testing.resetMemoryQueue();
});

describe('isPurgableRoot', () => {
  it('只接受 owners/ 之内的路径', () => {
    const owners = '/data/owners';
    expect(isPurgableRoot('/data/owners/abc/device-link-mirror-cache', owners)).toBe(true);
    expect(isPurgableRoot('/data/owners', owners)).toBe(false);
    expect(isPurgableRoot('/data/other/abc', owners)).toBe(false);
    expect(isPurgableRoot('/data/owners/../secrets', owners)).toBe(false);
    expect(isPurgableRoot('', owners)).toBe(false);
  });
});

describe('enqueuePurge / drainPurgeQueue', () => {
  it('入队后消化成功 → 目录被删、队列文件消失', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    expect(fs.existsSync(queueFile())).toBe(true);

    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(queueFile())).toBe(false);
  });

  it('同一目录重复入队只保留一条,attempts 累加', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    await enqueuePurge(root);
    const entries = await __testing.readQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(2);
  });

  it('owners/ 之外的路径拒绝入队(不给自己造一把任意删除的武器)', async () => {
    const outside = path.join(userData, 'not-owners', 'x');
    await fsp.mkdir(outside, { recursive: true });
    await enqueuePurge(outside);
    expect(fs.existsSync(queueFile())).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('队列文件被改写成 owners 之外的路径 → 消化时丢弃,不照着删', async () => {
    const victim = path.join(userData, 'important');
    await fsp.mkdir(victim, { recursive: true });
    await fsp.writeFile(
      queueFile(),
      JSON.stringify({ version: 1, entries: [{ root: victim, since: 1, attempts: 1 }] }),
      'utf8',
    );

    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 0, pending: 0 });
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(queueFile())).toBe(false);
  });

  it('空队列 / 损坏 JSON → 安全返回零,不抛错', async () => {
    expect(await drainPurgeQueue()).toEqual({ purged: 0, pending: 0 });
    await fsp.writeFile(queueFile(), 'not json', 'utf8');
    expect(await drainPurgeQueue()).toEqual({ purged: 0, pending: 0 });
  });

  it('目标已经不存在 → 算清掉(rm force 幂等),条目移除', async () => {
    const root = path.join(userData, 'owners', 'owner-gone', 'device-link-mirror-cache');
    await fsp.mkdir(root, { recursive: true });
    await enqueuePurge(root);
    await fsp.rm(root, { recursive: true, force: true });

    expect(await drainPurgeQueue()).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(queueFile())).toBe(false);
  });
});

describe('文件级条目(clearDevice 删不掉时用)', () => {
  it('只删列出的文件,不动同目录的其它缓存', async () => {
    const root = await makeOwnerCache('owner-1');
    const mine = path.join(root, 'messages', 'a.json');
    const other = path.join(root, 'messages', 'b.json');
    await fsp.writeFile(other, '{}', 'utf8');

    await enqueuePurge(root, [mine]);
    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });

  // review(greptile + codex P1):clearDevice 在 messages/ 枚举失败时登记的是**目录**,
  // 非递归 rm 对非空目录报 ERR_FS_EISDIR → 权限恢复后这条重试也永远失败。
  it('目录型目标(枚举失败时登记的 messages/)能被递归清掉', async () => {
    const root = await makeOwnerCache('owner-1');
    const dir = path.join(root, 'messages');
    await fsp.writeFile(path.join(dir, 'b.json'), '{}', 'utf8');

    await enqueuePurge(root, [dir]);
    const result = await drainPurgeQueue();

    expect(result).toEqual({ purged: 1, pending: 0 });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('root 之外的文件路径拒绝入队(不给自己造越界删除的能力)', async () => {
    const root = await makeOwnerCache('owner-1');
    const outside = path.join(userData, 'owners', 'owner-2', 'secret.json');
    await fsp.mkdir(path.dirname(outside), { recursive: true });
    await fsp.writeFile(outside, '{}', 'utf8');

    await enqueuePurge(root, [outside]);

    expect(fs.existsSync(queueFile())).toBe(false);
    expect(await drainPurgeQueue()).toEqual({ purged: 0, pending: 0 });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('文件级条目与整根条目互不覆盖', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    await enqueuePurge(root, [path.join(root, 'messages', 'a.json')]);
    expect(await __testing.readQueue()).toHaveLength(2);
  });
});

describe('并发 mutation', () => {
  // review(codex P1):drain 取完快照、enqueue 写入新记录、drain 收尾写入把它覆盖掉 ——
  // 那条记录只剩内存,正常退出即丢,被撤销设备就此没有跨重启的重试。
  it('drain 与 enqueue 并发时,新入队的条目不会被 drain 的收尾写入抹掉', async () => {
    const purgeable = await makeOwnerCache('owner-1');
    await enqueuePurge(purgeable);
    // 第二台设备的缓存:enqueue 与 drain 同时发生
    const late = path.join(userData, 'owners', 'owner-2', 'device-link-mirror-cache');
    await fsp.mkdir(path.join(late, 'messages'), { recursive: true });
    const stuck = path.join(late, 'messages', 'locked.json');
    await fsp.writeFile(stuck, '{}', 'utf8');
    await fsp.chmod(path.join(late, 'messages'), 0o500); // 让它删不掉,好断言仍在队列里

    try {
      await Promise.all([drainPurgeQueue(), enqueuePurge(late, [stuck])]);

      const entries = await __testing.readQueue();
      // owner-1 已清掉;owner-2 的新条目必须还在(且已落盘,不只在内存里)
      expect(fs.existsSync(purgeable)).toBe(false);
      expect(entries.map((e) => e.root)).toContain(late);
      const persisted = JSON.parse(await fsp.readFile(queueFile(), 'utf8')) as {
        entries: Array<{ root: string }>;
      };
      expect(persisted.entries.map((e) => e.root)).toContain(late);
    } finally {
      await fsp.chmod(path.join(late, 'messages'), 0o700);
    }
  });
});

describe('超量路径分片', () => {
  // review(codex P1):clearDevice 最坏情况会交来「200 个消息文件 + session-list.json」共 201 条,
  // 旧实现按 200 截断,丢掉的恰是最后追加的 session-list —— 消息删了、被撤销设备的元数据
  // 永久留在盘上还能被 hydrate 回侧边栏。
  it('路径数超单条目上限时拆成多条,一条都不丢(尾部的 session-list 也在)', async () => {
    const root = path.join(userData, 'owners', 'owner-1', 'device-link-mirror-cache');
    await fsp.mkdir(path.join(root, 'messages'), { recursive: true });
    const files = Array.from({ length: 200 }, (_, i) => path.join(root, 'messages', `m${i}.json`));
    const listFile = path.join(root, 'session-list.json');
    for (const file of [...files, listFile]) await fsp.writeFile(file, '{}', 'utf8');

    await enqueuePurge(root, [...files, listFile]);

    const entries = await __testing.readQueue();
    const queued = entries.flatMap((entry) => entry.paths ?? []);
    expect(entries.length).toBe(2);
    expect(queued).toHaveLength(201);
    expect(queued).toContain(listFile);

    // 消化后 201 个文件全都没了(不是"删了 200 个、留下元数据")。
    const result = await drainPurgeQueue();
    expect(result.pending).toBe(0);
    expect(fs.existsSync(listFile)).toBe(false);
    expect(fs.existsSync(files[0])).toBe(false);
  });

  it('条目数超上限时合并成整根条目(整根是超集,不静默丢路径)', async () => {
    // 33 台设备各留一条文件级失败记录 → 超过 MAX_ENTRIES(32),合并成 1 条整根条目。
    const root = path.join(userData, 'owners', 'owner-1', 'device-link-mirror-cache');
    await fsp.mkdir(path.join(root, 'messages'), { recursive: true });
    for (let i = 0; i < 33; i += 1) {
      const file = path.join(root, 'messages', `dev-${i}.json`);
      await fsp.writeFile(file, '{}', 'utf8');
      await enqueuePurge(root, [file]);
    }

    const entries = await __testing.readQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].paths).toBeUndefined();
    expect(entries[0].root).toBe(root);

    const result = await drainPurgeQueue();
    expect(result.pending).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('跨进程锁', () => {
  // review(codex P1):dev 实例与打包实例可以共用同一个 userData,两个进程各自「读 → 改 →
  // 整份写回」会互相覆盖,输的那条只剩在自己进程的内存表里,退出即丢。
  function lockFile(): string {
    return path.join(userData, __testing.lockFileName);
  }

  it('临界区结束后不留锁文件', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    expect(fs.existsSync(lockFile())).toBe(false);
    await drainPurgeQueue();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('崩溃残留的陈旧锁会被接管,记录照常落盘', async () => {
    const root = await makeOwnerCache('owner-1');
    await fsp.writeFile(lockFile(), '99999', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lockFile(), old, old);

    await enqueuePurge(root);

    __testing.resetMemoryQueue();
    expect((await __testing.readQueue()).map((e) => e.root)).toEqual([root]);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  // review(codex P1):降级成"无锁整份读改写"等于把上一轮修掉的丢更新又放回来。
  // 现在降级走**追加**:一条记录一个文件,只碰自己那一个,别的实例整份写正本也抹不掉它。
  it('锁被别人持有时改成追加落盘:不丢记录,且不覆盖正本里别人的条目', async () => {
    const mine = await makeOwnerCache('owner-1');
    const theirs = path.join(userData, 'owners', 'owner-2', 'device-link-mirror-cache');
    await fsp.mkdir(theirs, { recursive: true });
    // 正本里已经有"另一个实例"记下的条目。
    await fsp.writeFile(
      queueFile(),
      JSON.stringify({ version: 1, entries: [{ root: theirs, since: 1, attempts: 1 }] }),
      'utf8',
    );
    await fsp.writeFile(lockFile(), '99999', 'utf8'); // 新鲜锁:本进程抢不到

    try {
      await enqueuePurge(mine);

      // 正本没被整份覆盖(别人的条目还在),自己的条目落在追加目录里。
      const persisted = JSON.parse(await fsp.readFile(queueFile(), 'utf8')) as {
        entries: Array<{ root: string }>;
      };
      expect(persisted.entries.map((e) => e.root)).toEqual([theirs]);
      const pendingDir = path.join(userData, __testing.pendingDirName);
      expect(fs.readdirSync(pendingDir).filter((n) => n.endsWith('.json')).length).toBe(1);

      // 「下次启动」只读盘:两条都在。
      __testing.resetMemoryQueue();
      expect((await __testing.readQueue()).map((e) => e.root).sort()).toEqual(
        [mine, theirs].sort(),
      );
    } finally {
      await fsp.rm(lockFile(), { force: true });
    }
  }, 20_000);

  it('拿到锁的 drain 把追加条目折进正本并删掉追加文件', async () => {
    const root = await makeOwnerCache('owner-1');
    await fsp.writeFile(lockFile(), '99999', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lockFile(), old, old); // 陈旧锁:下一次会接管
    await fsp.rm(lockFile(), { force: true });
    // 直接造一个追加条目(等价于上一次降级写下的)
    const pendingDir = path.join(userData, __testing.pendingDirName);
    await fsp.mkdir(pendingDir, { recursive: true });
    await fsp.writeFile(
      path.join(pendingDir, 'abc.json'),
      JSON.stringify({ version: 1, entries: [{ root, since: 1, attempts: 1 }] }),
      'utf8',
    );
    __testing.resetMemoryQueue();

    const result = await drainPurgeQueue();

    expect(result.purged).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(pendingDir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });
});

describe('条目数超上限', () => {
  // review(codex P1):不同 owner root 之间无法合并(一个账号的清理代表不了另一个账号),
  // 旧实现 slice(0, 32) 会把较新的 root 永久丢掉,那个账号的明文缓存再也没有重试机会。
  it('超过上限的**不同 root** 溢写到追加目录,一个都不丢', async () => {
    const roots: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      roots.push(await makeOwnerCache(`owner-${i}`));
    }
    for (const root of roots) await enqueuePurge(root);

    __testing.resetMemoryQueue(); // 只看盘上
    const persisted = await __testing.readQueue();
    expect(persisted.map((e) => e.root).sort()).toEqual([...roots].sort());

    // 全部都能被消化掉。
    const result = await drainPurgeQueue();
    expect(result.purged).toBe(40);
    for (const root of roots) expect(fs.existsSync(root)).toBe(false);
  }, 30_000);
});

describe('溢写失败', () => {
  // review(codex P1):「追加目录写不进、正本可写」时,被挤出正本的那条记录在盘上一份都不剩。
  it('追加目录不可写 → enqueuePurge 抛错(不静默提交被截断的正本)', async () => {
    const roots: string[] = [];
    for (let i = 0; i < 33; i += 1) roots.push(await makeOwnerCache(`owner-${i}`));
    for (const root of roots.slice(0, 32)) await enqueuePurge(root);
    // 把追加目录位置占成普通文件:mkdir / writeFile 必然失败。
    await fsp.writeFile(path.join(userData, __testing.pendingDirName), 'not a dir', 'utf8');

    await expect(enqueuePurge(roots[32])).rejects.toThrow();
    // 内存里仍有它,本进程后续 drain 照样会重试。
    expect(__testing.memoryQueueSize()).toBeGreaterThan(0);
  }, 30_000);
});

describe('锁的所有权', () => {
  function lockPath(): string {
    return path.join(userData, __testing.lockFileName);
  }

  // review(codex P1):临界区包含递归删除,正常持锁的 drain 完全可能跑过 10 秒。
  // 只按 mtime 抢锁会挤掉活着的持有者,它随后还会在 finally 里删掉别人的锁。
  it('owner 进程还活着 → 陈旧 mtime 也不接管(降级走追加)', async () => {
    const root = await makeOwnerCache('owner-1');
    // 用**本测试进程之外**的活进程当 owner:process.ppid 一定活着且不是自己。
    await fsp.writeFile(
      lockPath(),
      JSON.stringify({ pid: process.ppid, startedAt: 1 }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lockPath(), old, old);

    try {
      await enqueuePurge(root);

      // 没有接管:锁还在,且内容仍是那个 owner 的。
      const owner = JSON.parse(await fsp.readFile(lockPath(), 'utf8')) as { pid: number };
      expect(owner.pid).toBe(process.ppid);
      // 记录走了追加路径,没丢。
      __testing.resetMemoryQueue();
      expect((await __testing.readQueue()).map((e) => e.root)).toEqual([root]);
    } finally {
      await fsp.rm(lockPath(), { force: true });
    }
  }, 20_000);

  it('owner 进程已经不在 → 接管陈旧锁', async () => {
    const root = await makeOwnerCache('owner-1');
    // 一个几乎不可能存在的 pid(用完即弃的高位数字)。
    await fsp.writeFile(lockPath(), JSON.stringify({ pid: 2_147_483_600, startedAt: 1 }), 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lockPath(), old, old);

    await enqueuePurge(root);

    // 接管后正常释放,锁不残留;条目落在正本里(不是追加目录)。
    expect(fs.existsSync(lockPath())).toBe(false);
    const persisted = JSON.parse(await fsp.readFile(queueFile(), 'utf8')) as {
      entries: Array<{ root: string }>;
    };
    expect(persisted.entries.map((e) => e.root)).toEqual([root]);
  });

  it('锁已被别人接管时不替他删(释放前先认 pid)', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root); // 正常一轮:锁建了又删了
    // 模拟"我们持锁期间被接管":手工写一个别人的锁,再跑一轮(会走追加降级)。
    await fsp.writeFile(lockPath(), JSON.stringify({ pid: process.ppid, startedAt: 1 }), 'utf8');
    try {
      await enqueuePurge(root);
      expect(fs.existsSync(lockPath())).toBe(true); // 别人的锁还在
    } finally {
      await fsp.rm(lockPath(), { force: true });
    }
  }, 20_000);
});

describe('队列文件原子落位', () => {
  // review(greptile P1 / security):这份文件是「缓存没清干净」唯一的跨重启痕迹。直接覆写时
  // 进程在写入中途被杀会留下截断的 JSON,下次启动解析失败被当成空队列,而内存兜底早已
  // 随进程消失 —— 那些明文缓存就此永久失去清理机会。
  it('写入后不留 .tmp 残留,文件始终是可解析 JSON', async () => {
    const rootA = await makeOwnerCache('owner-1');
    const rootB = await makeOwnerCache('owner-2');
    await enqueuePurge(rootA);
    await enqueuePurge(rootB);

    expect(fs.readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const parsed = JSON.parse(await fsp.readFile(queueFile(), 'utf8')) as {
      entries: Array<{ root: string }>;
    };
    expect(parsed.entries.map((e) => e.root).sort()).toEqual([rootA, rootB].sort());
  });

  it.skipIf((process.getuid?.() ?? 0) === 0)(
    '落位失败时旧队列内容保持完整(不会被截断成半个文件)',
    async () => {
      const rootA = await makeOwnerCache('owner-1');
      await enqueuePurge(rootA);
      const before = await fsp.readFile(queueFile(), 'utf8');

      // userData 变只读:tmp 建不出来 → 写入失败。旧实现直接覆写目标文件,这一步就会
      // 把已有记录截断/清掉;原子落位则原样保留。
      const rootB = await makeOwnerCache('owner-2');
      await fsp.chmod(userData, 0o500);
      try {
        await expect(enqueuePurge(rootB)).rejects.toThrow();
        expect(await fsp.readFile(queueFile(), 'utf8')).toBe(before);
        expect(JSON.parse(before)).toBeTruthy();
        // 新条目虽然没落盘,本进程内仍会被 drain 重试(内存兜底)。
        expect(__testing.memoryQueueSize()).toBeGreaterThan(0);
      } finally {
        await fsp.chmod(userData, 0o700);
      }
    },
  );
});

describe('Windows 落位退路', () => {
  // review(greptile P1 / security):Windows 上目标已存在时 rename 可能报 EPERM / EACCES /
  // EBUSY(杀软、索引器、另一个实例打开着),直接失败会让这条记录只剩内存、退出即丢。
  // 退路是「先把正本挪成 .bak 再落位」,任一步崩溃盘上都还有一份完整 JSON。
  it('正本缺失时从 .bak 读回待清记录', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    // 模拟「挪走正本、尚未落位」的瞬间。
    await fsp.rename(queueFile(), `${queueFile()}.bak`);
    // 关键:清掉内存兜底,否则读的是本进程内存里那份,盘上的回退根本没被考。
    // 真实场景就是「下次启动」——内存表按定义是空的。
    __testing.resetMemoryQueue();

    const entries = await __testing.readQueue();
    expect(entries.map((e) => e.root)).toEqual([root]);

    // 而且照样能被消化掉(不是只能读、不能用)。
    const result = await drainPurgeQueue();
    expect(result.purged).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('正本是半个文件时回退 .bak,而不是被当成空队列', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    await fsp.copyFile(queueFile(), `${queueFile()}.bak`);
    await fsp.writeFile(queueFile(), '{"version":1,"entries":[{"root":"', 'utf8'); // 截断
    __testing.resetMemoryQueue(); // 同上:考的是「下次启动只有盘」

    expect((await __testing.readQueue()).map((e) => e.root)).toEqual([root]);
  });

  it('队列清空时 .bak 一起删掉(否则已清条目会被复活)', async () => {
    const root = await makeOwnerCache('owner-1');
    await enqueuePurge(root);
    await fsp.copyFile(queueFile(), `${queueFile()}.bak`);

    await drainPurgeQueue();
    __testing.resetMemoryQueue();

    expect(fs.existsSync(queueFile())).toBe(false);
    expect(fs.existsSync(`${queueFile()}.bak`)).toBe(false);
    expect(await __testing.readQueue()).toEqual([]);
  });

  it('落位成功后不留 .bak(留着会让下次读取回退到过期清单)', async () => {
    const rootA = await makeOwnerCache('owner-1');
    const rootB = await makeOwnerCache('owner-2');
    await enqueuePurge(rootA);
    await fsp.copyFile(queueFile(), `${queueFile()}.bak`);
    await enqueuePurge(rootB);

    expect(fs.existsSync(`${queueFile()}.bak`)).toBe(false);
  });
});

describe('落盘失败', () => {
  // review(codex P1):唯一的持久重试记录写不下去却报成功 = 静默丢失。
  it('队列文件写不下去时 enqueuePurge 抛错,但条目留在内存里仍会被 drain 重试', async () => {
    const root = await makeOwnerCache('owner-1');
    // 把队列文件位置占成目录:writeFile 必然 EISDIR。
    await fsp.mkdir(queueFile(), { recursive: true });

    await expect(enqueuePurge(root)).rejects.toThrow();
    expect(__testing.memoryQueueSize()).toBe(1);

    const result = await drainPurgeQueue();
    expect(result.purged).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
    expect(__testing.memoryQueueSize()).toBe(0);
  });
});
