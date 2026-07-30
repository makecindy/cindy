/**
 * crossProcessLock —— 跨实例建议性文件锁的行为守卫。
 *
 * 这里只守一件最容易出事的:**接管陈旧锁的路径不能空转**。锁文件删不掉(Windows 上
 * EPERM / EBUSY 最常见)时,"陈旧 + owner 已死"的判定下一轮仍然成立 —— 原实现 catch 掉
 * 删除失败就 continue,于是变成没有退避、没有截止时间的忙等,把调用方永久卡住
 * (review: copilot)。其余行为(存活判定、不删别人的锁、降级语义)由
 * mirrorCachePurgeQueue.test.ts 的「锁的所有权」用例覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { withCrossProcessLock } from '../crossProcessLock';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-process-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一把「陈旧且 owner 已死」的锁:pid 用一个几乎不可能存在的值。 */
async function writeStaleLock(lock: string): Promise<void> {
  await fsp.writeFile(lock, JSON.stringify({ pid: 0x7ffffffe, startedAt: 1 }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(lock, old, old);
}

describe('接管陈旧锁', () => {
  it('删得掉 → 接管成功,task 拿到 held=true', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleLock(lock);

    const status = await withCrossProcessLock(lock, { label: 'test', waitMs: 200 }, async (s) => s);

    expect(status).toEqual({ held: true });
  });

  it('锁文件删不掉 → 立刻降级返回,不空转到超时(更不无限循环)', async () => {
    const lock = path.join(dir, 'lock');
    await writeStaleLock(lock);
    const originalRm = fsp.rm;
    let rmAttempts = 0;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation((async (
      target: unknown,
      ...rest: unknown[]
    ) => {
      if (typeof target === 'string' && target === lock) {
        rmAttempts += 1;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (originalRm as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as unknown as typeof fsp.rm);
    try {
      const started = performance.now();
      const status = await withCrossProcessLock(
        lock,
        { label: 'test', waitMs: 5_000 },
        async (s) => s,
      );
      const elapsed = performance.now() - started;

      // 降级(而不是宣称持有):内容写会跳过,清理路径照常执行。
      expect(status).toEqual({ held: false, reason: 'busy' });
      // 不该把 waitMs 熬完,也不该反复重试删除。
      expect(elapsed).toBeLessThan(1_000);
      expect(rmAttempts).toBe(1);
      // 别人的锁没被动过。
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
