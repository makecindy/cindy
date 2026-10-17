// GhostOverlayCursorStream 单测:30Hz 节拍、可见期推送、订阅/退订、定时器生命周期。
// 用 fake timers 精确推进,断言真实推送次数与推送对象;不依赖 electron。

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GhostOverlayCursorStream,
  GHOST_OVERLAY_CURSOR_STREAM_INTERVAL_MS,
  type GhostOverlayCursorStreamDeps,
} from '../cursor-stream.js';

interface SendRecord {
  ghostId: string;
  payload: { type: 'overlay-cursor'; x: number; y: number };
}

function makeHarness() {
  const sends: SendRecord[] = [];
  const deps: GhostOverlayCursorStreamDeps = {
    getCursorScreenPoint: () => ({ x: 7, y: 9 }),
    send: (ghostId, payload) => {
      sends.push({ ghostId, payload });
    },
    now: () => performance.now(),
  };
  const stream = new GhostOverlayCursorStream(deps);
  return { stream, sends };
}

describe('GhostOverlayCursorStream', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pushes at most 30 ticks per second with the cursor point payload', () => {
    vi.useFakeTimers();
    const { stream, sends } = makeHarness();
    stream.subscribe('ghost-a');
    stream.setVisible('ghost-a', true);

    vi.advanceTimersByTime(1000);

    // 33ms 一拍:1s 内恰好 30 拍。
    expect(sends.length).toBe(30);
    for (const record of sends) {
      expect(record).toEqual({
        ghostId: 'ghost-a',
        payload: { type: 'overlay-cursor', x: 7, y: 9 },
      });
    }
  });

  it('stops ticking when every ghost is hidden (no idle spinning)', () => {
    vi.useFakeTimers();
    const { stream, sends } = makeHarness();
    stream.subscribe('ghost-a');
    stream.setVisible('ghost-a', true);
    vi.advanceTimersByTime(330);
    expect(sends.length).toBeGreaterThan(0);

    stream.setVisible('ghost-a', false);
    const countAfterHide = sends.length;
    vi.advanceTimersByTime(1000);

    expect(sends.length).toBe(countAfterHide);
  });

  it('does not start while all subscriptions are invisible', () => {
    vi.useFakeTimers();
    const { stream, sends } = makeHarness();
    stream.subscribe('ghost-a');

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(sends.length).toBe(0);
  });

  it('does not push to unsubscribed ghosts', () => {
    vi.useFakeTimers();
    const { stream, sends } = makeHarness();
    stream.subscribe('ghost-a');
    stream.setVisible('ghost-a', true);
    stream.unsubscribe('ghost-a');

    vi.advanceTimersByTime(1000);
    expect(sends.length).toBe(0);

    // 从未订阅的 ghost 即使被 setVisible(true) 也不会推送。
    stream.setVisible('ghost-b', true);
    vi.advanceTimersByTime(1000);
    expect(sends.length).toBe(0);
  });

  it('only pushes to subscribed-and-visible ghosts among multiple', () => {
    vi.useFakeTimers();
    const { stream, sends } = makeHarness();
    stream.subscribe('ghost-a');
    stream.subscribe('ghost-b');
    stream.setVisible('ghost-a', true);
    // ghost-b 保持不可见,不应收到推送。

    vi.advanceTimersByTime(99); // 3 拍

    expect(sends.length).toBe(3);
    expect(sends.every((record) => record.ghostId === 'ghost-a')).toBe(true);
  });

  it('starts/stops the interval based on visible subscriptions (timer existence)', () => {
    vi.useFakeTimers();
    const { stream } = makeHarness();
    expect(vi.getTimerCount()).toBe(0);

    stream.subscribe('ghost-a');
    expect(vi.getTimerCount()).toBe(0); // 不可见不空转

    stream.setVisible('ghost-a', true);
    expect(vi.getTimerCount()).toBe(1);

    stream.setVisible('ghost-a', false);
    expect(vi.getTimerCount()).toBe(0);

    stream.setVisible('ghost-a', true);
    stream.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timer is unref-ed and dispose clears it exactly once', () => {
    const unref = vi.fn();
    const fakeTimer = {
      unref,
    } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    const { stream } = makeHarness();
    stream.subscribe('ghost-a');
    stream.setVisible('ghost-a', true);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      GHOST_OVERLAY_CURSOR_STREAM_INTERVAL_MS,
    );
    expect(unref).toHaveBeenCalledTimes(1);

    stream.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);

    // dispose 幂等:重复 dispose 不再 clear。
    stream.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
