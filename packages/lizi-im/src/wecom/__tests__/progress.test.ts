/**
 * 企业微信流式过程面的节流与终稿竞态。
 *
 * 测试价值
 * - 生产入口与可观察结果: createWecomProgress —— 用户在企业微信里看到的是一条
 *   原地刷新的流式消息; 密集事件不会变成每事件一帧, 终稿之后也不会再被"正在处理"
 *   覆盖。
 * - Bug／规则依据: 旧 beginReply 只发一个空占位, 整轮无进度; 且没有"收口串行"的
 *   约定, 迟到的进度帧可能落在终稿之后。
 * - 现有覆盖缺口: wecom/index.test.ts 只覆盖"开始/结束用同一个 streamId", 没有覆盖
 *   中间帧与收口时序。
 * - 最小失败输入: 一帧还在飞时调用 close(), 随后又来一次 replace。
 * - tier: unit(进程内依赖注入, 不发真实消息)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeWecomProgressContent,
  createWecomProgress,
  WECOM_PROGRESS_INTERVAL_MS,
} from '../progress.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('wecom streaming progress', () => {
  it('coalesces a burst of updates into one trailing frame per interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const frames: string[] = [];
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      replyStream: async (_streamId, content) => {
        frames.push(content);
      },
    });

    progress.replace({ stage: '⚙️ 正在处理 · 1s', body: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual(['⚙️ 正在处理 · 1s']);

    // 同一窗口内的密集更新只保留最后一帧(尾沿)。
    progress.replace({ stage: '⚙️ 已进行 1 步', body: '部分' });
    progress.replace({ stage: '⚙️ 已进行 2 步', body: '部分回答' });
    await vi.advanceTimersByTimeAsync(WECOM_PROGRESS_INTERVAL_MS);
    expect(frames).toEqual(['⚙️ 正在处理 · 1s', '⚙️ 已进行 2 步\n\n部分回答']);

    // 内容没变的帧不重复发。
    progress.replace({ stage: '⚙️ 已进行 2 步', body: '部分回答' });
    await vi.advanceTimersByTimeAsync(WECOM_PROGRESS_INTERVAL_MS);
    expect(frames).toHaveLength(2);
  });

  it('close() waits for the in-flight frame so nothing lands after the final answer', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const frames: string[] = [];
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      replyStream: async (_streamId, content) => {
        frames.push(content);
        await pending.promise;
      },
    });

    progress.replace({ stage: '⚙️ 正在处理', body: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);

    let closed = false;
    const closing = progress.close().then(() => {
      closed = true;
    });
    // 真实网络可以远慢于 200ms: 收口必须在帧落地之后才完成。
    await vi.advanceTimersByTimeAsync(250);
    expect(closed).toBe(false);

    // 收口开始之后到达的进度一律丢弃。
    progress.replace({ stage: '迟到的进度', body: '' });
    pending.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual(['⚙️ 正在处理']);
  });

  it('never spins when the turn is already invalid', async () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      shouldContinue: () => false,
      replyStream: async (_streamId, content) => {
        frames.push(content);
      },
    });
    progress.replace({ stage: '⚙️ 正在处理', body: '' });
    // 失效的轮次不排帧、不留定时器, 也不会在微任务里自旋。
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops scheduling after the turn goes invalid following one successful frame', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const frames: string[] = [];
    let alive = true;
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      shouldContinue: () => alive,
      replyStream: async (_streamId, content) => {
        frames.push(content);
      },
    });
    progress.replace({ stage: '⚙️ 第一帧', body: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual(['⚙️ 第一帧']);

    alive = false;
    progress.replace({ stage: '⚙️ 第二帧', body: '' });
    await vi.advanceTimersByTimeAsync(WECOM_PROGRESS_INTERVAL_MS * 3);
    expect(frames).toEqual(['⚙️ 第一帧']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry the same failed frame in a loop, but does send new content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const frames: string[] = [];
    let fail = true;
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      replyStream: async (_streamId, content) => {
        if (fail) throw new Error('frame rejected');
        frames.push(content);
      },
    });
    progress.replace({ stage: '⚙️ 同一帧', body: '' });
    await vi.advanceTimersByTimeAsync(0);
    // 同一帧失败后不无限重试。
    for (let index = 0; index < 5; index += 1) {
      progress.replace({ stage: '⚙️ 同一帧', body: '' });
      await vi.advanceTimersByTimeAsync(WECOM_PROGRESS_INTERVAL_MS);
    }
    expect(frames).toEqual([]);

    fail = false;
    progress.replace({ stage: '⚙️ 新内容', body: '正文' });
    await vi.advanceTimersByTimeAsync(WECOM_PROGRESS_INTERVAL_MS);
    expect(frames).toEqual(['⚙️ 新内容\n\n正文']);
  });

  it('ignores a late replace after close', async () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const progress = createWecomProgress({
      userId: 'owner',
      streamId: 'stream-1',
      replyStream: async (_streamId, content) => {
        frames.push(content);
      },
    });
    await progress.close();
    progress.replace({ stage: '⚙️ 迟到', body: '' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the stream content within the platform byte budget', () => {
    const content = composeWecomProgressContent({
      stage: '⚙️ 正在处理',
      body: 'x'.repeat(30_000),
    });
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(20_000);
    expect(content.startsWith('⚙️ 正在处理')).toBe(true);
  });
});
