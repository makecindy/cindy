/**
 * subscriptions topic 生命周期钩子单测:fs-watch 档的"订阅即 watch、归零即停"
 * 依赖这两个回调在全部四条入口(subscribe / unsubscribe / clearController /
 * clearAll)上正确触发——尤其断链清理(link-close / presence-offline)不能漏。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as subscriptions from '../subscriptions';

describe('subscriptions topic lifecycle listeners', () => {
  const subscribed = vi.fn();
  const released = vi.fn();

  beforeEach(() => {
    subscriptions.__testing.reset();
    subscribed.mockClear();
    released.mockClear();
    subscriptions.setTopicsSubscribedListener((t) => subscribed([...t]));
    subscriptions.setTopicsReleasedListener((t) => released([...t]));
  });

  afterEach(() => {
    subscriptions.setTopicsSubscribedListener(null);
    subscriptions.setTopicsReleasedListener(null);
    subscriptions.__testing.reset();
  });

  it('subscribe notifies (including idempotent replay after reconnect)', () => {
    subscriptions.subscribe('c1', ['fs-watch:/w1', 'sessions']);
    expect(subscribed).toHaveBeenCalledWith(['fs-watch:/w1', 'sessions']);
    // 重连 replay:同 topics 再订阅也要通知(消费方按幂等语义恢复 watch)。
    subscriptions.subscribe('c1', ['fs-watch:/w1']);
    expect(subscribed).toHaveBeenCalledTimes(2);
  });

  it('keeps negotiated controller capabilities until the controller is cleared', () => {
    subscriptions.subscribe('c1', ['sessions'], 'Phone', ['provider-logo-kinds-v2']);
    expect(subscriptions.controllerSupports('c1', 'provider-logo-kinds-v2')).toBe(true);
    subscriptions.subscribe('c1', ['session:s1'], 'Phone');
    expect(subscriptions.controllerSupports('c1', 'provider-logo-kinds-v2')).toBe(true);
    subscriptions.clearController('c1');
    expect(subscriptions.controllerSupports('c1', 'provider-logo-kinds-v2')).toBe(false);
  });

  it('unsubscribe releases only when no controller still holds the topic', () => {
    subscriptions.subscribe('c1', ['fs-watch:/w1']);
    subscriptions.subscribe('c2', ['fs-watch:/w1']);
    subscriptions.unsubscribe('c1', ['fs-watch:/w1']);
    expect(released).not.toHaveBeenCalled(); // c2 还持有
    subscriptions.unsubscribe('c2', ['fs-watch:/w1']);
    expect(released).toHaveBeenCalledWith(['fs-watch:/w1']);
  });

  it('clearController (link-close / presence-offline) releases orphaned topics', () => {
    subscriptions.subscribe('c1', ['fs-watch:/w1', 'session:s1']);
    subscriptions.subscribe('c2', ['session:s1']);
    subscriptions.clearController('c1');
    // fs-watch:/w1 归零 → released;session:s1 c2 还持有 → 不在列表里。
    expect(released).toHaveBeenCalledWith(['fs-watch:/w1']);
  });

  it('clearAll releases every held topic once', () => {
    subscriptions.subscribe('c1', ['fs-watch:/w1']);
    subscriptions.subscribe('c2', ['fs-watch:/w2', 'sessions']);
    subscriptions.clearAll();
    expect(released).toHaveBeenCalledTimes(1);
    const releasedTopics = released.mock.calls[0][0] as string[];
    expect(new Set(releasedTopics)).toEqual(new Set(['fs-watch:/w1', 'fs-watch:/w2', 'sessions']));
  });

  it('listener exceptions never break subscription bookkeeping', () => {
    subscriptions.setTopicsReleasedListener(() => {
      throw new Error('boom');
    });
    subscriptions.subscribe('c1', ['fs-watch:/w1']);
    expect(() => subscriptions.clearController('c1')).not.toThrow();
    expect(subscriptions.getControllerIds()).toEqual([]);
  });
});
