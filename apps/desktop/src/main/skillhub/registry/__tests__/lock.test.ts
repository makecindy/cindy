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

  it('不同 key 并行：三个临界区在某一刻同时开着（而非首尾相接）', async () => {
    // **不断言墙钟耗时**。原来是 `elapsed < delay * 2.5`（20ms × 2.5 = 50ms），Windows CI
    // 两分片并跑时 52ms 就把 main 打红了 —— 三个 20ms 的 sleep 串行才 60ms，阈值离"串行"
    // 只差 10ms，等于拿调度抖动当被测行为。
    //
    // 改成直接量"并行"本身：记下每个临界区的进入 / 离开时刻，断言
    // `max(进入) < min(离开)`，即存在一个瞬间三者同时在临界区内。串行执行下
    // 第二个的进入必然晚于第一个的离开，这条一定不成立。与机器快慢无关。
    const enter: number[] = [];
    const leave: number[] = [];
    const section = async (): Promise<void> => {
      enter.push(Date.now());
      await new Promise<void>((r) => setTimeout(r, 20));
      leave.push(Date.now());
    };

    await Promise.all([
      withLock('key-a', section),
      withLock('key-b', section),
      withLock('key-c', section),
    ]);

    expect(enter).toHaveLength(3);
    expect(leave).toHaveLength(3);
    expect(Math.max(...enter)).toBeLessThan(Math.min(...leave));
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
