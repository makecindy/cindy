import { describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ focused: false, push: vi.fn() }));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: navigation.push }),
  useNavigation: () => ({ isFocused: () => navigation.focused }),
  useFocusEffect: () => {},
}));
import { useGuardedPush } from '../utils/useGuardedPush';

import {
  SAME_TARGET_WINDOW_MS,
  TRANSITION_WINDOW_MS,
  createNavigationLock,
  createRefocusReset,
  forwardNavigationLock,
  navigationTargetKey,
} from '../utils/navigationLock';

/** 可手动推进的时间源,模拟连点 / 卡顿恢复后事件簇发的时序。 */
function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('createNavigationLock', () => {
  it('同一目标在窗口内只放行第一次(卡顿恢复后的连点簇)', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    // JS 恢复后排队的 press 几乎同时 fire
    expect(lock.shouldAllow('/sessions/a')).toBe(false);
    clock.advance(80);
    expect(lock.shouldAllow('/sessions/a')).toBe(false);
    clock.advance(SAME_TARGET_WINDOW_MS);
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
  });

  it('不同目标在转场窗口内拒绝、窗口外放行', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    // 转场动画期间误触另一行
    clock.advance(TRANSITION_WINDOW_MS - 1);
    expect(lock.shouldAllow('/sessions/b')).toBe(false);
    // 被拒的尝试不刷新登记,从首次放行起算窗口
    clock.advance(1);
    expect(lock.shouldAllow('/sessions/b')).toBe(true);
  });

  it('时钟回拨时不放行第二层,且登记自愈到当前时间(不锁死到时钟追上)', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    clock.advance(-60_000);
    expect(lock.shouldAllow('/sessions/a')).toBe(false);
    // 登记已被拉回回拨后的时间:再等一个窗口就能放行,不需要等时钟追回 60s
    clock.advance(SAME_TARGET_WINDOW_MS);
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
  });

  it('reset 后立即放行', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    lock.reset();
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
  });

  it('放行会刷新登记:连续两个不同目标各自起算窗口', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    clock.advance(TRANSITION_WINDOW_MS);
    expect(lock.shouldAllow('/sessions/b')).toBe(true);
    // b 刚放行,窗口重新起算
    expect(lock.shouldAllow('/sessions/c')).toBe(false);
  });
});

describe('createRefocusReset', () => {
  it('首次 focus(挂载进入)不释放锁:目标页转场 focus 不能放穿发起页排队的补点', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    const onTargetFocus = createRefocusReset(lock);
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    // 目标页挂载,转场开始即触发 focus
    onTargetFocus();
    // 发起页排队的补点此刻才 fire,必须仍被挡住
    expect(lock.shouldAllow('/sessions/a')).toBe(false);
  });

  it('重新 focus(从下一层返回)释放锁:返回后立即再点不被残留窗口误吞', () => {
    const clock = createClock();
    const lock = createNavigationLock({ now: clock.now });
    const onListFocus = createRefocusReset(lock);
    onListFocus(); // 列表页首挂载
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
    // 快手:进入后立刻返回,总耗时仍在同目标窗口内
    clock.advance(500);
    onListFocus(); // 返回列表页,重新获得焦点
    expect(lock.shouldAllow('/sessions/a')).toBe(true);
  });
});

describe('navigationTargetKey', () => {
  it('string 目标直接作为 key', () => {
    expect(navigationTargetKey('/settings')).toBe('/settings');
  });

  it('object 目标按 pathname + 排序 params 生成,顺序无关', () => {
    const a = navigationTargetKey({
      pathname: '/sessions/[sessionId]',
      params: { sessionId: 's1', deviceId: 'd1' },
    });
    const b = navigationTargetKey({
      pathname: '/sessions/[sessionId]',
      params: { deviceId: 'd1', sessionId: 's1' },
    });
    expect(a).toBe(b);
    expect(a).toContain('/sessions/[sessionId]');
  });

  it('不同 params 生成不同 key;undefined 值忽略', () => {
    const base = navigationTargetKey({ pathname: '/p', params: { a: '1' } });
    const withUndefined = navigationTargetKey({ pathname: '/p', params: { a: '1', b: undefined } });
    const different = navigationTargetKey({ pathname: '/p', params: { a: '2' } });
    expect(withUndefined).toBe(base);
    expect(different).not.toBe(base);
  });

  it('无 params 的 object 退化为 pathname', () => {
    expect(navigationTargetKey({ pathname: '/devices/[deviceId]' })).toBe('/devices/[deviceId]');
  });
});

describe('useGuardedPush 焦点门(source 契约)', () => {
  it('push 前必须过 isFocused 门:失焦(导航已在路上)的补点一律丢弃', async () => {
    // JS 长停摆会把补点分散到多个恢复间隙,墙钟窗口对「跨停摆补点」失效
    // (2026-07-18 同一会话被连开 N 层实锤);焦点门是时间窗之外的确定性防线。
    forwardNavigationLock.reset();
    navigation.push.mockClear();
    navigation.focused = false;
    const push = useGuardedPush();
    push('/sessions/a');
    expect(navigation.push).not.toHaveBeenCalled();
    navigation.focused = true;
    push('/sessions/a');
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/sessions/a');
    forwardNavigationLock.reset();
  });
});
