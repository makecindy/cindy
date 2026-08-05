/**
 * lock.test.ts — per-name 串行队列行为验证
 */
import { describe, it, expect } from 'vitest';
import { withLock } from '../lock.js';

describe('withLock', () => {
  it('同 key 多次并发 → 严格串行（计数器按序递增）', async () => {
    const order: number[] = [];
    let counter = 0;

    const tasks = Array.from({ length: 10 }, () =>
      withLock('test-skill', async () => {
        const myNum = counter++;
        // 模拟异步操作
        await new Promise<void>((r) => setTimeout(r, 1));
        order.push(myNum);
        return myNum;
      }),
    );

    const results = await Promise.all(tasks);
    // 结果必须按 0~9 严格递增（串行保证）
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('100 次并发同 skillName → 最终 counter === 100（无竞态）', async () => {
    let counter = 0;
    const tasks = Array.from({ length: 100 }, () =>
      withLock('concurrent-skill', async () => {
        const cur = counter;
        await new Promise<void>((r) => setTimeout(r, 0));
        counter = cur + 1;
      }),
    );
    await Promise.all(tasks);
    expect(counter).toBe(100);
  });

  it('不同 key 并行，耗时近似单次而非 N 倍', async () => {
    const delay = 20; // ms
    const start = Date.now();

    await Promise.all([
      withLock('key-a', () => new Promise<void>((r) => setTimeout(r, delay))),
      withLock('key-b', () => new Promise<void>((r) => setTimeout(r, delay))),
      withLock('key-c', () => new Promise<void>((r) => setTimeout(r, delay))),
    ]);

    const elapsed = Date.now() - start;
    // 并行时应该约 delay ms 完成（而非 3*delay）
    expect(elapsed).toBeLessThan(delay * 2.5);
  });

  it('前一个 task 失败，后续 task 仍可执行', async () => {
    const results: string[] = [];

    await Promise.allSettled([
      withLock('error-skill', async () => {
        results.push('task1-start');
        throw new Error('task1 failed');
      }),
      withLock('error-skill', async () => {
        results.push('task2');
      }),
    ]);

    expect(results).toContain('task1-start');
    expect(results).toContain('task2');
  });

  it('返回 fn 的 resolved 值', async () => {
    const result = await withLock('return-skill', async () => 42);
    expect(result).toBe(42);
  });
});
