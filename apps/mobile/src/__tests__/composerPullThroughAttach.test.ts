import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Animated: { ScrollView: {} },
  Platform: { OS: 'android' },
}));
vi.mock('react-native-reanimated', () => ({
  measure: () => null,
  runOnJS: (fn: unknown) => fn,
  useAnimatedReaction: () => undefined,
  useAnimatedRef: () => ({ current: null }),
  useSharedValue: (initial: unknown) => ({ value: initial }),
}));
vi.mock('@/platform/gestureHandler', () => ({
  Gesture: {},
  GestureDetector: () => null,
}));

import { resolvePullThroughAttach } from '@/session/composerPullThrough';

describe('composer pull-through gesture attach gate', () => {
  it('android keeps RNGH off the message list while the composer is idle', () => {
    // RNGH 编排器接管触摸流会让 Android selectable 正文一拖就进选区、列表不滚。
    expect(resolvePullThroughAttach({ android: true, armed: false, busy: false })).toBe(false);
  });

  it('android attaches while the composer is expanded', () => {
    expect(resolvePullThroughAttach({ android: true, armed: true, busy: false })).toBe(true);
  });

  it('android stays attached while a handoff is in flight even after collapse', () => {
    // armed 会在拖动收起输入框时翻 false；busy 期间必须保持 enabled，
    // 否则 tracker 的 end() 不跑，被 setFrozen(true) 冻住的滚动无法恢复。
    expect(resolvePullThroughAttach({ android: true, armed: false, busy: true })).toBe(true);
    expect(resolvePullThroughAttach({ android: true, armed: true, busy: true })).toBe(true);
  });

  it('ios keeps the always-attached behavior unchanged', () => {
    expect(resolvePullThroughAttach({ android: false, armed: false, busy: false })).toBe(true);
  });
});
