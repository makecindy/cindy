/**
 * withGhostInstallLock — 按 ghostId 的互斥。同 id 串行、异 id 并行。
 */
import { describe, expect, it } from 'vitest';

import { withGhostInstallLock } from '../ghostInstallLock';

/** 手动可控的 deferred,便于精确编排交错。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('withGhostInstallLock', () => {
  it('同一 ghostId 串行:第二笔在第一笔释放前不得进入临界区', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = withGhostInstallLock('ghost-x', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    // 让 a 先取得锁并进入 fn。
    await Promise.resolve();
    const b = withGhostInstallLock('ghost-x', async () => {
      order.push('b:start');
    });
    // a 尚未释放:b 绝不能开始。
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('前一笔抛错不卡死后一笔(链在成败后都继续)', async () => {
    const order: string[] = [];
    const failing = withGhostInstallLock('ghost-y', async () => {
      order.push('boom');
      throw new Error('boom');
    });
    const next = withGhostInstallLock('ghost-y', async () => {
      order.push('after');
    });
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(order).toEqual(['boom', 'after']);
  });

  it('不同 ghostId 并行:互不阻塞', async () => {
    const order: string[] = [];
    const xGate = deferred();
    const x = withGhostInstallLock('ghost-x', async () => {
      order.push('x:start');
      await xGate.promise;
    });
    await Promise.resolve();
    // y 与 x 不同 id:即使 x 仍持锁,y 也应立即进入。
    const y = withGhostInstallLock('ghost-y', async () => {
      order.push('y:start');
    });
    await y;
    expect(order).toContain('y:start');
    xGate.resolve();
    await x;
  });
});
