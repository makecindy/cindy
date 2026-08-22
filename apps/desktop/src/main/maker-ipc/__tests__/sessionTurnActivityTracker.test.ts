/**
 * sessionTurnActivityTracker.test.ts —— 本地「逻辑 turn」视图(anySessionInTurn 关窗 busy 判断 +
 * reconcileTurnIdle 的依赖)。
 *
 * 核心性质:turn 正常结束(terminal 广播)时 isSessionInTurn 必须**立即**翻 false;keepalive grace
 * (只服务 background throttling)绝不能拖住它。
 * 注意:per-session 的 `maker:session-in-turn` 查询**不**依赖本 tracker —— 它以 live
 * `session.isTurnRunning()` 为权威(规避 tracker 在 turn 异常死亡时 stale 为 in-turn),本测只锁 tracker 自身行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isSessionTurnDispatchBoundaryBusy,
  listSessionIdsInTurn,
  SessionTurnActivityTracker,
} from '../sessionTurnActivityTracker';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SessionTurnActivityTracker.isSessionInTurn', () => {
  it('lists only sessions that are active at the snapshot boundary', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('active-a', true);
    t.setSessionInTurn('idle', false);
    t.setSessionInTurn('active-b', true);

    expect(t.sessionIdsInTurn()).toEqual(['active-a', 'active-b']);
  });

  it('includes live running sessions before their status event reaches the tracker', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('tracked', true);

    expect(
      listSessionIdsInTurn(t, [
        { id: 'tracked', isTurnRunning: () => true },
        { id: 'live-dispatch-gap', isTurnRunning: () => true },
        { id: 'idle', isTurnRunning: () => false },
      ]),
    ).toEqual(['tracked', 'live-dispatch-gap']);
  });

  it('setSessionInTurn 翻起/落下', () => {
    const t = new SessionTurnActivityTracker();
    expect(t.isSessionInTurn('s')).toBe(false); // 未知 session → false(安全默认)
    t.setSessionInTurn('s', true);
    expect(t.isSessionInTurn('s')).toBe(true);
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', null)).toBe(true);
    t.setSessionInTurn('s', false);
    expect(t.isSessionInTurn('s')).toBe(false);
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', null)).toBe(false);
  });

  it('terminal 广播 → isSessionInTurn 立即 false(keepalive grace 不拖住它)', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('s', true);
    t.scheduleIdleAfterTerminalBroadcast('s');
    // 关键:不等 grace 计时器,isSessionInTurn 当下就是 false → 看门狗据此安全收尾
    expect(t.isSessionInTurn('s')).toBe(false);
    // grace 期内 anySessionInTurn 也已为 false(只有 keepalive 还 true,服务 throttling)
    expect(t.anySessionInTurn()).toBe(false);
    vi.advanceTimersByTime(2000); // grace 过后仍 false
    expect(t.isSessionInTurn('s')).toBe(false);
    t.deleteSession('s');
  });

  it('deleteSession → isSessionInTurn false', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('s', true);
    t.deleteSession('s');
    expect(t.isSessionInTurn('s')).toBe(false);
  });

  it('一个 session 在跑不影响另一个的 per-session 查询', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('a', true);
    expect(t.isSessionInTurn('a')).toBe(true);
    expect(t.isSessionInTurn('b')).toBe(false); // per-session,不串
  });
});

describe('isSessionTurnDispatchBoundaryBusy', () => {
  it('keeps coordinator dispatch busy while maker-core live state is running before tracker starts', () => {
    const t = new SessionTurnActivityTracker();
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', { isTurnRunning: () => true })).toBe(true);
  });

  it('keeps coordinator dispatch busy after live state goes idle until terminal delivery is processed', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('s', true);
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', { isTurnRunning: () => false })).toBe(true);
  });

  it('keeps coordinator dispatch busy after status idle broadcast until terminal broadcast', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('s', true);
    t.scheduleIdleAfterStatusBroadcast('s');

    expect(t.isSessionInTurn('s')).toBe(false);
    expect(t.anySessionInTurn()).toBe(false);
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', { isTurnRunning: () => false })).toBe(true);

    t.scheduleIdleAfterTerminalBroadcast('s');
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', { isTurnRunning: () => false })).toBe(false);
  });

  it('releases coordinator dispatch after terminal broadcast even during keepalive grace', () => {
    const t = new SessionTurnActivityTracker();
    t.setSessionInTurn('s', true);
    t.scheduleIdleAfterTerminalBroadcast('s');

    expect(isSessionTurnDispatchBoundaryBusy(t, 's', { isTurnRunning: () => false })).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(isSessionTurnDispatchBoundaryBusy(t, 's', null)).toBe(false);
  });
});
