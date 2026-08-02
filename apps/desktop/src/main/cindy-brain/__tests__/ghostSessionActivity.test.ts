/**
 * ghostSessionActivity.test.ts — 意识后台活动跟踪器单测(纯 DI,假定时器)。
 * 覆盖:begin/end 的 0↔1 广播、同会话多 key 引用计数、noteCardUpdate 的
 * working 续期 / done 收口 / 未跟踪 working 补开 / 未跟踪 null 不点亮、
 * TTL 静默超时兜底、同 key 重复 begin 不重复广播。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GHOST_SESSION_ACTIVITY_TTL_MS,
  GhostSessionActivityTracker,
} from '../ghostSessionActivity';

/** 手动可控的定时器池:fire(n) 触发第 n 次 schedule 的回调(未取消时)。 */
function makeTracker() {
  const broadcast = vi.fn();
  const timers = new Map<number, () => void>();
  let seq = 0;
  const tracker = new GhostSessionActivityTracker({
    broadcast,
    scheduleTimeout: (fn) => {
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    cancelTimeout: (handle) => {
      timers.delete(handle as number);
    },
    log: { debug: vi.fn(), warn: vi.fn() },
  });
  return {
    tracker,
    broadcast,
    fire: (handle: number) => {
      const fn = timers.get(handle);
      timers.delete(handle);
      fn?.();
    },
    pendingTimerIds: () => [...timers.keys()],
  };
}

describe('GhostSessionActivityTracker', () => {
  it('begin → busy 广播一次;done 收口 → idle 广播一次', () => {
    const { tracker, broadcast } = makeTracker();
    tracker.begin('k1', 's1');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('s1', true);
    expect(tracker.isSessionBusy('s1')).toBe(true);

    tracker.noteCardUpdate('k1', 's1', 'done');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith('s1', false);
    expect(tracker.isSessionBusy('s1')).toBe(false);
  });

  it('同会话多 key 引用计数:最后一个结束才熄', () => {
    const { tracker, broadcast } = makeTracker();
    tracker.begin('k1', 's1');
    tracker.begin('k2', 's1');
    expect(broadcast).toHaveBeenCalledTimes(1); // 0→1 只广播一次

    tracker.end('k1');
    expect(broadcast).toHaveBeenCalledTimes(1); // 还剩 k2,不熄
    tracker.end('k2');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith('s1', false);
  });

  it('同 key 重复 begin 只续期,不重复计数/广播;end 幂等', () => {
    const { tracker, broadcast } = makeTracker();
    tracker.begin('k1', 's1');
    tracker.begin('k1', 's1');
    expect(broadcast).toHaveBeenCalledTimes(1);
    tracker.end('k1');
    tracker.end('k1');
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('noteCardUpdate:working 续期(换新 TTL 定时器);null 只给已跟踪 key 续期', () => {
    const { tracker, fire, pendingTimerIds, broadcast } = makeTracker();
    tracker.begin('k1', 's1');
    const [t1] = pendingTimerIds();
    tracker.noteCardUpdate('k1', 's1', 'working');
    // 旧定时器已被取消:触发它不产生任何效果。
    fire(t1);
    expect(tracker.isSessionBusy('s1')).toBe(true);

    tracker.noteCardUpdate('k1', null, null); // 未声明 state 也续期
    expect(tracker.isSessionBusy('s1')).toBe(true);

    // 未跟踪 key 的 null 更新不点亮。
    tracker.noteCardUpdate('kx', 's2', null);
    expect(tracker.isSessionBusy('s2')).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith('s2', true);
  });

  it('未跟踪 key 的 working 更新补开(TTL 过期 / 重启后仍在干活)', () => {
    const { tracker, broadcast } = makeTracker();
    tracker.noteCardUpdate('k9', 's9', 'working');
    expect(tracker.isSessionBusy('s9')).toBe(true);
    expect(broadcast).toHaveBeenCalledWith('s9', true);
    // sessionId 查无时不点亮(不知道归谁)。
    tracker.noteCardUpdate('k10', null, 'working');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('TTL 静默超时兜底熄呼吸', () => {
    const { tracker, broadcast, pendingTimerIds, fire } = makeTracker();
    tracker.begin('k1', 's1');
    const [ttl] = pendingTimerIds();
    fire(ttl);
    expect(tracker.isSessionBusy('s1')).toBe(false);
    expect(broadcast).toHaveBeenLastCalledWith('s1', false);
  });

  it('TTL 常量覆盖 mivo 单窗轮询(105s)', () => {
    expect(GHOST_SESSION_ACTIVITY_TTL_MS).toBeGreaterThan(105_000);
  });

  // anySessionBusy 给「这个破坏性动作会不会打断正在干的活」这类全局判定用(更新重启前的
  // 阻断探针)。那些调用方没有 sessionId 可传,而 renderer 侧的 store 只靠 0↔1 推送累积、
  // 没有全量快照通道,不能当权威来源。
  describe('anySessionBusy', () => {
    it('没有任何在途活动时为 false', () => {
      const { tracker } = makeTracker();
      expect(tracker.anySessionBusy()).toBe(false);
    });

    it('任意会话有在途活动即为 true', () => {
      const { tracker } = makeTracker();
      tracker.begin('k1', 's1');
      expect(tracker.anySessionBusy()).toBe(true);
    });

    it('多会话时要等最后一个结束才回到 false', () => {
      const { tracker } = makeTracker();
      tracker.begin('k1', 's1');
      tracker.begin('k2', 's2');
      tracker.end('k1');
      expect(tracker.isSessionBusy('s1')).toBe(false);
      // s2 还在干活 —— 此时重启仍会打断它。
      expect(tracker.anySessionBusy()).toBe(true);
      tracker.end('k2');
      expect(tracker.anySessionBusy()).toBe(false);
    });

    it('TTL 兜底熄灭后也回到 false(意识崩了不会永久拦住重启)', () => {
      const { tracker, pendingTimerIds, fire } = makeTracker();
      tracker.begin('k1', 's1');
      expect(tracker.anySessionBusy()).toBe(true);
      const [ttl] = pendingTimerIds();
      fire(ttl);
      expect(tracker.anySessionBusy()).toBe(false);
    });
  });
});
