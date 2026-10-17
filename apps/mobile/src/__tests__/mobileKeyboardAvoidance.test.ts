// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  KeyboardAvoidingView: () => null,
  Platform: { OS: 'android' },
  StyleSheet: { create: (value: unknown) => value },
  View: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
vi.mock('@/session/useMobileKeyboardState', () => ({
  useMobileKeyboardState: () => ({ height: 0, visible: false, screenY: null, transition: { current: null } }),
}));
import { computeAndroidKeyboardInsetLift } from '@/session/mobileKeyboardAvoidance';

const base = {
  imeHeight: 300,
  systemBarBottom: 24,
  fullHeight: 844,
  viewportHeight: 844,
  windowVisibleBottom: null as number | null,
};

describe('computeAndroidKeyboardInsetLift', () => {
  it('asks for the keyboard height when the window did not shrink (edge-to-edge)', () => {
    // 系统没有缩窗（screenY 退化为窗口底边或缺失）→ 全额让位；导航栏只算一次。
    expect(computeAndroidKeyboardInsetLift(base)).toBe(324);
    expect(computeAndroidKeyboardInsetLift({ ...base, windowVisibleBottom: 844 })).toBe(324);
  });

  it('does not double-avoid when adjustResize already shrank the window', () => {
    // 旧系统：窗口真的矮了 324，且事件 screenY（520）证实可见区正好停在键盘顶边。
    expect(computeAndroidKeyboardInsetLift({
      ...base,
      viewportHeight: 520,
      windowVisibleBottom: 520,
    })).toBe(0);
  });

  it('falls back to the shrink amount when the keyboard event is from another window', () => {
    // 事件 screenY 退化为窗口底边（844），但窗口确实缩了 → 按缩窗量抵扣。
    expect(computeAndroidKeyboardInsetLift({
      ...base,
      viewportHeight: 520,
      windowVisibleBottom: 844,
    })).toBe(0);
  });

  it('treats unknown window heights as «nothing reserved»', () => {
    expect(computeAndroidKeyboardInsetLift({ ...base, fullHeight: 0 })).toBe(324);
    expect(computeAndroidKeyboardInsetLift({ ...base, viewportHeight: Number.NaN })).toBe(324);
  });

  it('ignores sub-pixel resize noise instead of flickering', () => {
    expect(computeAndroidKeyboardInsetLift({ ...base, viewportHeight: 836 })).toBe(324);
  });

  it('stays at zero while the keyboard is hidden', () => {
    expect(computeAndroidKeyboardInsetLift({ ...base, imeHeight: 0, systemBarBottom: 0 })).toBe(0);
    expect(computeAndroidKeyboardInsetLift({ ...base, imeHeight: -8, systemBarBottom: 0 })).toBe(0);
  });

  it('never lifts more than the keyboard or into the negative', () => {
    expect(computeAndroidKeyboardInsetLift({ ...base, windowVisibleBottom: -10 })).toBe(324);
    expect(computeAndroidKeyboardInsetLift({ ...base, viewportHeight: 1200 })).toBe(324);
  });
});
