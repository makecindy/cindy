import { describe, expect, it } from 'vitest';
import {
  WIDE_SESSION_NAV_MIN_WIDTH,
  buildWideSessionNavLayout,
} from '@/session/wideSessionNav';

describe('buildWideSessionNavLayout', () => {
  it('keeps portrait phones on the classic back-button navigation', () => {
    // iPhone SE / 15 Pro / 16 Pro Max 竖屏与 iPad 窄分屏(约 1/3)都必须回退返回键。
    for (const windowWidth of [320, 375, 393, 440]) {
      expect(buildWideSessionNavLayout({ windowHeight: 852, windowWidth })).toEqual({
        drawerWidth: 0,
        enabled: false,
      });
    }
  });

  it('enables drawer navigation for iPad both orientations', () => {
    // iPad mini 竖屏(744)/ iPad Pro 横屏(1366)。
    expect(buildWideSessionNavLayout({ iosPad: true, platform: 'ios', windowHeight: 1133, windowWidth: 744 }).enabled).toBe(true);
    expect(buildWideSessionNavLayout({ iosPad: true, platform: 'ios', windowHeight: 1024, windowWidth: 1366 }).enabled).toBe(true);
    // iPad 窄分屏(~1/3)回退返回键。
    expect(buildWideSessionNavLayout({ iosPad: true, platform: 'ios', windowHeight: 1024, windowWidth: 320 }).enabled).toBe(false);
  });

  it('keeps iPhone on back-button navigation even in landscape (per-platform rollout)', () => {
    // 发布策略:iOS 只发 iPad;iPhone 横屏达宽也不启用宽屏形态。
    expect(buildWideSessionNavLayout({ iosPad: false, platform: 'ios', windowHeight: 393, windowWidth: 852 }).enabled).toBe(false);
    expect(buildWideSessionNavLayout({ platform: 'ios', windowHeight: 393, windowWidth: 852 }).enabled).toBe(false);
  });

  it('enables drawer navigation for unfolded foldables even in portrait (android)', () => {
    // Pixel Fold 内屏竖持(约 648×672)——宽度已达 medium 档,不要求 landscape。
    const layout = buildWideSessionNavLayout({ platform: 'android', windowHeight: 672, windowWidth: 648 });
    expect(layout.enabled).toBe(true);
  });

  it('enables drawer navigation for android landscape phones', () => {
    const layout = buildWideSessionNavLayout({ platform: 'android', windowHeight: 393, windowWidth: 852 });
    expect(layout.enabled).toBe(true);
  });

  it('clamps drawer width to a readable range', () => {
    // 断点下缘:0.4×600=240 < 300,顶到下限。
    expect(buildWideSessionNavLayout({ windowHeight: 900, windowWidth: 600 }).drawerWidth).toBe(300);
    // 大屏:0.4×1366=546 > 360,压到上限。
    expect(buildWideSessionNavLayout({ windowHeight: 1024, windowWidth: 1366 }).drawerWidth).toBe(360);
    // 区间内按比例取整。
    expect(buildWideSessionNavLayout({ windowHeight: 1133, windowWidth: 800 }).drawerWidth).toBe(320);
  });

  it('treats missing or invalid dimensions as narrow (fail closed to back button)', () => {
    expect(buildWideSessionNavLayout({}).enabled).toBe(false);
    expect(buildWideSessionNavLayout({ windowHeight: Number.NaN, windowWidth: Number.NaN }).enabled).toBe(false);
    expect(buildWideSessionNavLayout({ windowHeight: 800, windowWidth: -1 }).enabled).toBe(false);
  });

  it('keeps the breakpoint constant aligned with the documented medium window class', () => {
    expect(WIDE_SESSION_NAV_MIN_WIDTH).toBe(600);
    expect(buildWideSessionNavLayout({ windowHeight: 900, windowWidth: 599 }).enabled).toBe(false);
    expect(buildWideSessionNavLayout({ windowHeight: 900, windowWidth: 600 }).enabled).toBe(true);
  });
});
