import { describe, expect, it } from 'vitest';
import { computeAndroidSheetKeyboardLift } from '@/session/sheetKeyboardAvoidance';

const base = {
  imeHeight: 300,
  systemBarBottom: 0,
  contentHeight: 844,
  baselineContentHeight: 844,
};

describe('computeAndroidSheetKeyboardLift', () => {
  it('asks for the keyboard height when the window did not shrink (edge-to-edge)', () => {
    expect(computeAndroidSheetKeyboardLift(base)).toBe(300);
  });

  it('re-adds the system bar that RN subtracted from the IME height', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, systemBarBottom: 24 })).toBe(324);
  });

  it('does not double-avoid when the window really shrank', () => {
    expect(computeAndroidSheetKeyboardLift({
      ...base, systemBarBottom: 24, contentHeight: 520,
    })).toBe(0);
  });

  it('ignores screen/Dimensions movement when the measured window did not shrink', () => {
    // MIUI 真机复现:键盘事件/尺寸随键盘变化,但浮窗窗口没有让出空间 → 仍要全额让位。
    expect(computeAndroidSheetKeyboardLift({ ...base, systemBarBottom: 24 })).toBe(324);
  });

  it('only lifts the part the system did not reserve', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, contentHeight: 744 })).toBe(200);
  });

  it('ignores sub-pixel resize noise instead of flickering', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, contentHeight: 836 })).toBe(300);
  });

  it('stays at zero while the keyboard is hidden', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 0 })).toBe(0);
    // 键盘收起但系统栏底仍为正:不能只补系统栏。
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 0, systemBarBottom: 24 })).toBe(0);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: -8, systemBarBottom: 0 })).toBe(0);
  });

  it('treats unknown geometry as «nothing reserved»', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, baselineContentHeight: Number.NaN })).toBe(300);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: Number.NaN })).toBe(0);
  });

  it('never returns a negative lift and rounds fractional geometry', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, contentHeight: 0 })).toBe(0);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 300.4 })).toBe(300);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 300.5 })).toBe(301);
  });
});
