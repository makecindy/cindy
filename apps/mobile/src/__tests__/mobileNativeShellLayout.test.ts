import { describe, expect, it } from 'vitest';
import {
  buildSessionNativeShellLayout,
  keyboardAvoidingBehaviorForPlatform,
} from '@/session/mobileNativeShellLayout';
import { buildMobileReadableViewportLayout } from '@/session/responsiveViewportLayout';

describe('mobileNativeShellLayout', () => {
  it('uses native keyboard avoiding behavior by platform', () => {
    expect(keyboardAvoidingBehaviorForPlatform('ios')).toBe('padding');
    expect(keyboardAvoidingBehaviorForPlatform('android')).toBe('height');
    expect(keyboardAvoidingBehaviorForPlatform('native')).toBe('height');
    expect(keyboardAvoidingBehaviorForPlatform('web')).toBeUndefined();
  });

  it('keeps the composer compact and scrollable when the keyboard is visible on small screens', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: true,
      keyboardHeight: 300,
      keyboardVisible: true,
      paletteOpen: false,
      platform: 'ios',
      safeAreaBottomInset: 34,
      screenHeight: 667,
    });

    expect(layout.keyboardAvoidingBehavior).toBe('padding');
    expect(layout.keyboardBottomInset).toBe(266);
    expect(layout.composerScrollEnabled).toBe(true);
    expect(layout.composerMaxHeight).toBeLessThanOrEqual(264);
    expect(layout.pendingSurfaceMaxHeight).toBeLessThan(667 * 0.62);
    expect(layout.pendingSurfaceExpandedHeight).toBe(layout.sheetMaxHeight + 34);
    expect(layout.sheetMaxHeight).toBeLessThan(667 * 0.88);
  });

  it('keeps normal session surfaces roomy when the keyboard is hidden', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: false,
      keyboardHeight: 0,
      keyboardVisible: false,
      paletteOpen: false,
      platform: 'ios',
      safeAreaBottomInset: 34,
      screenHeight: 932,
    });

    expect(layout.keyboardBottomInset).toBe(0);
    expect(layout.composerScrollEnabled).toBe(false);
    expect(layout.composerMaxHeight).toBeGreaterThan(300);
    expect(layout.pendingSurfaceMaxHeight).toBe(layout.sheetMaxHeight + 34);
    expect(layout.pendingSurfaceExpandedHeight).toBe(layout.sheetMaxHeight + 34);
    expect(layout.sheetMaxHeight).toBe(Math.round(932 * 0.88));
    expect(layout.wideViewport).toBe(false);
    expect(layout.contentMaxWidth).toBe(390);
  });

  it.each([100, 80, 79, 35, 34, 4, 0, 700])(
    'keeps the absolute composer above the keyboard at %s pt of actual overlap',
    (keyboardHeight) => {
      const layout = buildSessionNativeShellLayout({
        attachmentPickerOpen: false,
        keyboardHeight,
        keyboardVisible: keyboardHeight > 0,
        paletteOpen: false,
        platform: 'ios',
        safeAreaBottomInset: 34,
        screenHeight: 844,
      });
      // 真实页面的绝对 bottom + 内层 safe area 是输入区距窗口底的总留白。
      expect(layout.keyboardBottomInset + 34).toBe(Math.max(keyboardHeight, 34));
    },
  );

  it('caps palettes independently from the composer so message history remains mounted', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: false,
      keyboardHeight: 330,
      keyboardVisible: true,
      paletteOpen: true,
      platform: 'ios',
      safeAreaBottomInset: 34,
      screenHeight: 852,
    });

    expect(layout.keyboardBottomInset).toBe(296);
    expect(layout.composerScrollEnabled).toBe(true);
    expect(layout.pendingSurfaceMaxHeight).toBeLessThan(layout.sheetMaxHeight);
    expect(layout.paletteMaxHeight).toBeLessThanOrEqual(260);
    expect(layout.paletteMaxHeight).toBeLessThan(layout.composerMaxHeight);
  });

  it('allows iPhone landscape without letting composer sheets take over the viewport', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: false,
      keyboardHeight: 0,
      keyboardVisible: false,
      paletteOpen: false,
      platform: 'ios',
      safeAreaBottomInset: 21,
      screenHeight: 393,
      screenWidth: 852,
    });

    expect(layout.landscape).toBe(true);
    expect(layout.wideViewport).toBe(true);
    expect(layout.contentMaxWidth).toBeLessThan(852);
    expect(layout.contentMaxWidth).toBeGreaterThanOrEqual(520);
    expect(layout.composerMaxHeight).toBeLessThanOrEqual(184);
    expect(layout.paletteMaxHeight).toBeLessThanOrEqual(180);
    expect(layout.sheetMaxHeight).toBeLessThanOrEqual(Math.round(393 * 0.84));
  });

  it('caps iPad readable content width instead of stretching message UI edge to edge', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: false,
      keyboardHeight: 0,
      keyboardVisible: false,
      paletteOpen: false,
      platform: 'ios',
      safeAreaBottomInset: 24,
      screenHeight: 1366,
      screenWidth: 1024,
    });

    expect(layout.landscape).toBe(false);
    expect(layout.wideViewport).toBe(true);
    expect(layout.contentMaxWidth).toBe(760);
    expect(layout.contentWidth).toBe(760);
    expect(layout.composerMaxHeight).toBe(360);
  });

  it('does not double-offset Android where KeyboardAvoidingView owns the height change', () => {
    const layout = buildSessionNativeShellLayout({
      attachmentPickerOpen: false,
      keyboardHeight: 300,
      keyboardVisible: true,
      paletteOpen: false,
      platform: 'android',
      safeAreaBottomInset: 24,
      screenHeight: 852,
    });

    expect(layout.keyboardAvoidingBehavior).toBe('height');
    expect(layout.keyboardBottomInset).toBe(0);
  });

  it('uses the same readable viewport rule for message and composer surfaces', () => {
    const layout = buildMobileReadableViewportLayout({
      screenHeight: 834,
      screenWidth: 1194,
    });

    expect(layout.landscape).toBe(true);
    expect(layout.wideViewport).toBe(true);
    expect(layout.shortViewport).toBe(false);
    expect(layout.contentMaxWidth).toBe(760);
  });
});
