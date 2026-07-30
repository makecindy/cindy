/**
 * 续跑信号层: 四条信号各自的订阅 / 发布 / 退订与相互隔离。
 *
 * 这一层只做进程内 fan-out, **不含**任何"哪一轮才算续跑"的判定 —— 判定全在 coordinator
 * 侧(它手里有 originalSyntheticTrigger 与 clientId), 见 agent-input-coordinator 的用例。
 * 这里要锁的是: 四条通道不互相串台、clientId 原样透传(它是消费方唯一的归属键)、
 * 监听方抛错不会顺着信号炸回用户的发送事务。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  onUiContinuation,
  onUiSessionIntervention,
  onUiTurnDispatching,
  onUiTurnUndispatched,
  publishUiContinuation,
  publishUiSessionIntervention,
  publishUiTurnDispatching,
  publishUiTurnUndispatched,
  resetUiContinuationListenersForTest,
} from '../uiContinuationSignal';

afterEach(() => {
  resetUiContinuationListenersForTest();
});

/** 一次性订阅全部四条通道, 收集各自收到的参数。 */
function collectAll() {
  const retry: Array<[string, string]> = [];
  const dispatching: Array<[string, string]> = [];
  const undispatched: Array<[string, string]> = [];
  const intervention: string[] = [];
  const offs = [
    onUiContinuation((s, c) => retry.push([s, c])),
    onUiTurnDispatching((s, c) => dispatching.push([s, c])),
    onUiTurnUndispatched((s, c) => undispatched.push([s, c])),
    onUiSessionIntervention((s) => intervention.push(s)),
  ];
  return {
    retry,
    dispatching,
    undispatched,
    intervention,
    unsubscribeAll: () => offs.forEach((off) => off()),
  };
}

describe('uiContinuationSignal', () => {
  it('四条通道各自独立, 不串台', () => {
    const c = collectAll();
    publishUiContinuation('s1', 'cid-1');
    publishUiTurnDispatching('s2', 'cid-2');
    publishUiTurnUndispatched('s3', 'cid-3');
    publishUiSessionIntervention('s4');

    expect(c.retry).toEqual([['s1', 'cid-1']]);
    expect(c.dispatching).toEqual([['s2', 'cid-2']]);
    expect(c.undispatched).toEqual([['s3', 'cid-3']]);
    expect(c.intervention).toEqual(['s4']);
  });

  it('clientId 原样透传 —— 它是消费方唯一的归属键', () => {
    const c = collectAll();
    publishUiContinuation('s1', 'retry-of-that-exact-message');
    publishUiTurnDispatching('s1', 'retry-of-that-exact-message');
    expect(c.retry[0]?.[1]).toBe('retry-of-that-exact-message');
    expect(c.dispatching[0]?.[1]).toBe('retry-of-that-exact-message');
  });

  it('退订后不再收到', () => {
    const c = collectAll();
    c.unsubscribeAll();
    publishUiContinuation('s1', 'cid-1');
    publishUiTurnDispatching('s1', 'cid-1');
    publishUiTurnUndispatched('s1', 'cid-1');
    publishUiSessionIntervention('s1');
    expect(c.retry).toEqual([]);
    expect(c.dispatching).toEqual([]);
    expect(c.undispatched).toEqual([]);
    expect(c.intervention).toEqual([]);
  });

  it('监听方抛错被吞掉, 且不影响同通道的其它监听方', () => {
    // 回流是增强而非关键路径: 绝不能让一个监听方的异常顺着信号炸回用户的发送事务。
    const seen: string[] = [];
    onUiContinuation(() => {
      throw new Error('listener boom');
    });
    onUiContinuation((s) => seen.push(s));
    expect(() => publishUiContinuation('s1', 'cid-1')).not.toThrow();
    expect(seen).toEqual(['s1']);
  });

  it('没有订阅方时发布是 no-op', () => {
    expect(() => publishUiContinuation('s1', 'cid-1')).not.toThrow();
    expect(() => publishUiTurnDispatching('s1', 'cid-1')).not.toThrow();
    expect(() => publishUiTurnUndispatched('s1', 'cid-1')).not.toThrow();
    expect(() => publishUiSessionIntervention('s1')).not.toThrow();
  });
});
