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

  it('可重入:同一上下文嵌套取同一 id 不自锁', async () => {
    // 锁同时加在三个卡点与各调用方的复核段上,外层已持有时内层必须是 no-op,
    // 否则市场路径(外层持锁)进入 installOrUpdateMarketGhostPackage(卡点也取锁)
    // 就会等自己释放 → 永久挂起。
    const order: string[] = [];
    await withGhostInstallLock('ghost-z', async () => {
      order.push('outer');
      await withGhostInstallLock('ghost-z', async () => {
        order.push('inner');
        // 再套一层也一样(卡点可能层层嵌套:service → install.ts → market 出口)。
        await withGhostInstallLock('ghost-z', async () => {
          order.push('innermost');
        });
      });
    });
    expect(order).toEqual(['outer', 'inner', 'innermost']);
  });

  it('可重入不放宽互斥:嵌套期间外部的同 id 请求仍被挡住', async () => {
    const order: string[] = [];
    const gate = deferred();
    const holder = withGhostInstallLock('ghost-w', async () => {
      await withGhostInstallLock('ghost-w', async () => {
        order.push('nested:enter');
        await gate.promise;
        order.push('nested:exit');
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    // 另一个**独立上下文**的同 id 请求不是重入,必须排队。
    const outsider = withGhostInstallLock('ghost-w', async () => {
      order.push('outsider');
    });
    await Promise.resolve();
    expect(order).toEqual(['nested:enter']);
    gate.resolve();
    await Promise.all([holder, outsider]);
    expect(order).toEqual(['nested:enter', 'nested:exit', 'outsider']);
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
