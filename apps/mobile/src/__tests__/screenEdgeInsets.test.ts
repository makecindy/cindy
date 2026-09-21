import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 36 },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
}));
import {
  getStablePortraitTopMemory,
  isLegacyPhoneWindow,
  recordStablePortraitTop,
  resetStablePortraitTopMemoryForTests,
  resolveScreenEdgePadding,
} from '@/components/screenEdgeInsets';

describe('screenEdgeInsets', () => {
  beforeEach(() => {
    resetStablePortraitTopMemoryForTests();
  });

  it('passes through normal portrait insets (top only, no side insets)', () => {
    expect(resolveScreenEdgePadding({
      insets: { top: 59, left: 0, right: 0 },
      windowHeight: 874,
      windowWidth: 402,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 59 });
  });

  it('keeps legitimate portrait side insets when top is non-zero (waterfall / side cutout)', () => {
    // 合法的竖屏侧边 inset 必然伴随非零状态栏 top,不属于横屏残留形态,原样透传。
    expect(resolveScreenEdgePadding({
      insets: { top: 24, left: 20, right: 20 },
      windowHeight: 800,
      windowWidth: 400,
    })).toEqual({ paddingLeft: 20, paddingRight: 20, paddingTop: 24 });
  });

  it('clamps the stale landscape residue shape in portrait and falls back top', () => {
    // 复现 bug 形态:横屏 insets(top=0、左右 59)残留到竖屏;侧边清零,top 用兜底值。
    expect(resolveScreenEdgePadding({
      legacyPhoneLayout: true,
      fallbackPortraitTop: 59,
      insets: { top: 0, left: 59, right: 59 },
      windowHeight: 874,
      windowWidth: 402,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 59 });
  });

  it('clamps single-side landscape residue without a fallback top', () => {
    // Android 横屏单侧挖孔的残留形态;无兜底值时 top 为 0(与残留原值一致,不发明数据)。
    expect(resolveScreenEdgePadding({
      legacyPhoneLayout: true,
      insets: { top: 0, left: 30, right: 0 },
      windowHeight: 800,
      windowWidth: 400,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 0 });
  });

  it('preserves asymmetric side safe areas in a tall resizable window', () => {
    expect(resolveScreenEdgePadding({
      fallbackPortraitTop: 59,
      insets: { top: 0, left: 0, right: 64 },
      windowHeight: 800, windowWidth: 420,
    })).toEqual({ paddingLeft: 0, paddingRight: 64, paddingTop: 0 });
  });

  it('keeps side insets in landscape untouched', () => {
    expect(resolveScreenEdgePadding({
      insets: { top: 0, left: 59, right: 59 },
      windowHeight: 402,
      windowWidth: 874,
    })).toEqual({ paddingLeft: 59, paddingRight: 59, paddingTop: 0 });
  });

  it('sanitizes negative or non-finite inset values to 0', () => {
    expect(resolveScreenEdgePadding({
      insets: { top: Number.NaN, left: -10, right: Number.POSITIVE_INFINITY },
      windowHeight: 402,
      windowWidth: 874,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 0 });
  });

  it('records only stable portrait tops into module memory', () => {
    recordStablePortraitTop({ top: 59, windowHeight: 874, windowWidth: 402 });
    expect(getStablePortraitTopMemory()).toBe(59);
    // 横屏、残留形态(top=0)、非法值都不得污染记忆。
    recordStablePortraitTop({ top: 0, windowHeight: 874, windowWidth: 402 });
    recordStablePortraitTop({ top: 44, windowHeight: 402, windowWidth: 874 });
    recordStablePortraitTop({ top: Number.NaN, windowHeight: 874, windowWidth: 402 });
    expect(getStablePortraitTopMemory()).toBe(59);
  });

  it('module memory survives page remount: residue frame on a fresh instance still gets a top', () => {
    // 模拟「会话页横屏 → 返回首页(重挂)→ 转竖屏」:上一个实例记入的稳定竖屏 top
    // 对新实例的残留过渡帧依然可用(实例级 ref 会归零,模块级记忆不会)。
    recordStablePortraitTop({ top: 59, windowHeight: 874, windowWidth: 402 });
    expect(resolveScreenEdgePadding({
      legacyPhoneLayout: true,
      fallbackPortraitTop: getStablePortraitTopMemory(),
      insets: { top: 0, left: 59, right: 59 },
      windowHeight: 874,
      windowWidth: 402,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 59 });
  });
});


describe('legacy phone window eligibility', () => {
  const phone = { platform: 'android', version: 36, iosPad: false,
    windowWidth: 400, windowHeight: 776, screenWidth: 400, screenHeight: 800 };
  it('repairs Android full-screen single-cutout rotation residue', () => {
    expect(resolveScreenEdgePadding({ legacyPhoneLayout: isLegacyPhoneWindow(phone),
      fallbackPortraitTop: 24, insets: { top: 0, left: 30, right: 0 },
      windowWidth: 400, windowHeight: 776,
    })).toEqual({ paddingLeft: 0, paddingRight: 0, paddingTop: 24 });
  });
  it.each([
    { windowWidth: 320 }, { windowHeight: 400 },
    { screenWidth: 800, screenHeight: 1000, windowWidth: 800, windowHeight: 1000 },
    { platform: 'ios', version: 27 }, { platform: 'ios', version: 26, iosPad: true },
    { platform: 'web' },
  ])('keeps independent edges outside legacy phone windows: %o', (overrides) => {
    expect(isLegacyPhoneWindow({ ...phone, ...overrides })).toBe(false);
  });
  it('retains the pre-27 iPhone workaround', () => {
    expect(isLegacyPhoneWindow({ ...phone, platform: 'ios', version: 26 })).toBe(true);
  });
});
