/**
 * 待补传标记的可靠性锁（需求 §4.5 / §6 非功能性）。
 *
 * 用真实文件系统（`os.tmpdir()` + `mkdtemp`）而不是内存 fake：这一层的正确性**全靠 rename
 * 的原子替换语义**，把它换成 Map 的话测的就不是被测行为了。目录逐个用例独立、结束即清理。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOG_RETENTION_DAYS } from '../../../shared/logRetention';
import { PendingMarkerStore, __testing, type MarkerFs } from '../pendingMarkers';

const realFs: MarkerFs = {
  mkdirSync: (dir) => fs.mkdirSync(dir, { recursive: true }),
  readdirSync: (dir) => fs.readdirSync(dir),
  readFileSync: (file) => fs.readFileSync(file, 'utf-8'),
  writeFileSync: (file, data) => fs.writeFileSync(file, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file),
  statMtimeMs: (file) => fs.statSync(file).mtimeMs,
};

let dir = '';
let now = Date.UTC(2026, 7, 4, 12, 0, 0);
let tokenSeq = 0;
const warnings: string[] = [];
/**
 * claim 文件的「落盘时刻」由测试的假时钟决定。
 *
 * 真实 mtime 与注入的 now 是两套时间基准:把 now 拨到未来时,真实 mtime 仍然停在物理
 * 当下,于是每条 claim 都会立刻被判成过期。这里在 rename 时按假时钟记账、statMtimeMs
 * 从账本读——rename / unlink 仍然是真实文件系统调用(原子替换语义正是被测行为,不能 fake)。
 */
let claimMtimes = new Map<string, number>();

const clockedFs: MarkerFs = {
  ...realFs,
  renameSync: (from, to) => {
    realFs.renameSync(from, to);
    claimMtimes.set(to, now);
    claimMtimes.delete(from);
  },
  statMtimeMs: (file) => {
    const recorded = claimMtimes.get(file);
    if (recorded !== undefined) return recorded;
    return realFs.statMtimeMs(file);
  },
};

function makeStore(pid: number): PendingMarkerStore {
  return new PendingMarkerStore({
    dir,
    fs: clockedFs,
    now: () => now,
    pid,
    appVersion: '1.2.3',
    // 递增令牌:测试要能预期文件名,同时保持「每条标记令牌唯一」这个真实性质。
    randomToken: () => `tok${(tokenSeq += 1)}`,
    joinPath: (...parts) => path.join(...parts),
    warn: (message) => warnings.push(message),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-log-upload-markers-'));
  now = Date.UTC(2026, 7, 4, 12, 0, 0);
  tokenSeq = 0;
  warnings.length = 0;
  claimMtimes = new Map();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function listNames(): string[] {
  return fs.readdirSync(dir).sort();
}

describe('write', () => {
  it('写下的标记带唯一代次令牌，文件名含崩溃时刻与令牌', () => {
    const store = makeStore(100);
    const marker = store.write('crash', now - 5_000);
    expect(marker).not.toBeNull();
    expect(listNames()).toEqual([`pending-${now - 5_000}-${marker!.token}.json`]);
  });

  it('同一毫秒的两条崩溃标记不会互相覆盖（仅靠时间戳会）', () => {
    const store = makeStore(100);
    store.write('crash', now);
    store.write('crash', now);
    expect(listNames()).toHaveLength(2);
  });

  it('目录不可写时只 warn、返回 null，绝不抛（调用点在崩溃处理链上）', () => {
    const store = new PendingMarkerStore({
      dir,
      fs: { ...realFs, writeFileSync: () => { throw new Error('EROFS'); } },
      now: () => now,
      pid: 1,
      appVersion: '1.2.3',
      randomToken: () => 'tok',
      joinPath: (...parts) => path.join(...parts),
      warn: (message) => warnings.push(message),
    });
    expect(store.write('crash', now)).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('claimAll / 并发认领', () => {
  it('两个实例并发认领同一条标记，只有一个拿到', () => {
    makeStore(100).write('crash', now - 1_000);

    const a = makeStore(200).claimAll();
    const b = makeStore(300).claimAll();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('认领后文件名带 pid 与运行令牌（区分同 pid 的多次运行）', () => {
    makeStore(100).write('crash', now - 1_000);
    const claimed = makeStore(200).claimAll();
    expect(claimed[0].claimPath).toContain(`${__testing.CLAIM_MARK}200.`);
  });

  it('多条未传崩溃一次全部认领', () => {
    const store = makeStore(100);
    store.write('crash', now - 3_000);
    store.write('native-crash', now - 2_000);
    store.write('crash', now - 1_000);

    expect(makeStore(200).claimAll()).toHaveLength(3);
  });

  it('内容损坏的标记被删掉，不留下永远认领不动的垃圾', () => {
    fs.writeFileSync(path.join(dir, `pending-${now}-broken.json`), '{ not json');
    expect(makeStore(200).claimAll()).toHaveLength(0);
    expect(listNames()).toHaveLength(0);
  });

  it('超出本地日志保留期的标记直接丢弃（日志已被清理，补传无意义）', () => {
    const tooOld = now - (LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    makeStore(100).write('crash', tooOld);

    expect(makeStore(200).claimAll()).toHaveLength(0);
    expect(listNames()).toHaveLength(0);
  });

  it('保留期内的标记正常认领', () => {
    const stillFresh = now - (LOG_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000;
    makeStore(100).write('crash', stillFresh);
    expect(makeStore(200).claimAll()).toHaveLength(1);
  });
});

describe('resolveClaimed / releaseClaimed', () => {
  it('成功 ⇒ 清除；只删自己那一代，另一个实例刚写的新标记不受影响', () => {
    makeStore(100).write('crash', now - 5_000);
    const store = makeStore(200);
    const claimed = store.claimAll();
    // 认领之后,另一个实例(另一次崩溃)又写了一条新标记。
    makeStore(400).write('crash', now - 1_000);

    store.resolveClaimed(claimed[0]);

    const remaining = listNames();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain(`${now - 1_000}`);
  });

  it('失败 ⇒ 还原成原名，下次启动能重新认领', () => {
    makeStore(100).write('crash', now - 5_000);
    const store = makeStore(200);
    const claimed = store.claimAll();

    store.releaseClaimed(claimed[0]);

    expect(listNames()).toEqual([path.basename(claimed[0].originalPath)]);
    expect(makeStore(300).claimAll()).toHaveLength(1);
  });
});

describe('过期 claim 回收', () => {
  it('被强杀的实例留下的 claim 超时后可被重新认领', () => {
    makeStore(100).write('crash', now - 5_000);
    const abandoned = makeStore(200).claimAll();
    expect(abandoned).toHaveLength(1);

    // 时钟前进超过 STALE_CLAIM_MS:这条 claim 视为可回收。
    now += __testing.STALE_CLAIM_MS + 1_000;

    const recovered = makeStore(300).claimAll();
    expect(recovered).toHaveLength(1);
  });

  it('还新的 claim 不被抢走（另一个实例可能正在处理）', () => {
    makeStore(100).write('crash', now - 5_000);
    makeStore(200).claimAll();

    now += 60_000; // 远小于 STALE_CLAIM_MS

    expect(makeStore(300).claimAll()).toHaveLength(0);
  });
});

describe('clearAll', () => {
  it('授权被关闭 ⇒ 清空全部标记（含已认领的）', () => {
    const store = makeStore(100);
    store.write('crash', now - 3_000);
    store.write('native-crash', now - 2_000);
    makeStore(200).claimAll(); // 其中一条变成 claim 文件

    const removed = makeStore(300).clearAll();

    expect(removed).toBeGreaterThan(0);
    expect(listNames()).toHaveLength(0);
  });

  it('目录不存在时返回 0，不抛', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(makeStore(100).clearAll()).toBe(0);
  });
});

describe('originalNameOfClaim', () => {
  it('claim 文件名能还原出原始标记名', () => {
    expect(__testing.originalNameOfClaim('pending-123-abc.json.claim.42.deadbeef')).toBe(
      'pending-123-abc.json',
    );
  });
});
