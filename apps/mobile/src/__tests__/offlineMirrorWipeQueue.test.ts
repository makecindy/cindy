import { describe, expect, it, vi } from 'vitest';
import { createOfflineMirrorWipeQueue } from '@/device-link/offlineMirrorWipeQueue';

describe('offline mirror wipe queue', () => {
  it('coalesces one wave of wipes into a single flush', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    for (let i = 0; i < 80; i += 1) queue.enqueue(`dev-${i}`);

    // 同一 task 内的整波入队:只预约一次 flush,且在微任务里执行。
    expect(queue.pendingCount()).toBe(80);
    expect(flush).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(80);
    expect(flush.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['dev-0', 'dev-40', 'dev-79']),
    );
    expect(queue.pendingCount()).toBe(0);
  });

  it('flushes later tasks separately and dedupes ids within a wave', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);

    queue.enqueue('dev-a');
    queue.enqueue('dev-a');
    queue.enqueue('dev-b');
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual(['dev-a', 'dev-b']);

    // 后续 task 的 wipe 单独 flush,不与上一波合并(离线清理语义不变)。
    queue.enqueue('dev-c');
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0]).toEqual(['dev-c']);
  });

  it('ignores empty device ids', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);

    queue.enqueue('');
    expect(queue.pendingCount()).toBe(0);
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
  });
});
