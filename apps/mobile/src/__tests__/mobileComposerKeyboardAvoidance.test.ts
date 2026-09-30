import { describe, expect, it } from 'vitest';
import {
  ANDROID_VIEWPORT_RESIZE_THRESHOLD,
  androidComposerKeyboardBottomPadding,
  androidViewportShrink,
} from '@/session/mobileComposerKeyboardAvoidance';

const RESTING = 2400;
const NAV_BAR = 96;
const KEYBOARD = 900;

describe('androidViewportShrink', () => {
  it('reports the height the system already took away', () => {
    expect(androidViewportShrink({ restingWindowHeight: RESTING, windowHeight: RESTING - KEYBOARD })).toBe(KEYBOARD);
  });

  it('is zero when the window did not shrink (edge-to-edge)', () => {
    expect(androidViewportShrink({ restingWindowHeight: RESTING, windowHeight: RESTING })).toBe(0);
  });

  it('ignores sub-threshold jitter during the keyboard animation', () => {
    expect(androidViewportShrink({ restingWindowHeight: RESTING, windowHeight: RESTING - ANDROID_VIEWPORT_RESIZE_THRESHOLD })).toBe(0);
    expect(androidViewportShrink({ restingWindowHeight: RESTING, windowHeight: RESTING - ANDROID_VIEWPORT_RESIZE_THRESHOLD - 1 }))
      .toBe(ANDROID_VIEWPORT_RESIZE_THRESHOLD + 1);
  });

  it('never goes negative when the window grows (rotation, multi-window)', () => {
    expect(androidViewportShrink({ restingWindowHeight: RESTING, windowHeight: RESTING + 200 })).toBe(0);
  });
});

describe('androidComposerKeyboardBottomPadding', () => {
  it('is zero while the keyboard is hidden', () => {
    expect(androidComposerKeyboardBottomPadding({
      keyboardHeight: 0, bottomInset: NAV_BAR, restingWindowHeight: RESTING, windowHeight: RESTING,
    })).toBe(0);
  });

  it('lifts the composer by the keyboard height when edge-to-edge keeps the window full height', () => {
    expect(androidComposerKeyboardBottomPadding({
      keyboardHeight: KEYBOARD, bottomInset: NAV_BAR, restingWindowHeight: RESTING, windowHeight: RESTING,
    })).toBe(KEYBOARD - NAV_BAR);
  });

  it('does not double-compensate when the system already resized the window', () => {
    expect(androidComposerKeyboardBottomPadding({
      keyboardHeight: KEYBOARD, bottomInset: NAV_BAR, restingWindowHeight: RESTING, windowHeight: RESTING - KEYBOARD,
    })).toBe(0);
  });

  it('compensates only the part the system did not take when it shrank partially', () => {
    const systemShrink = 400;
    expect(androidComposerKeyboardBottomPadding({
      keyboardHeight: KEYBOARD, bottomInset: NAV_BAR, restingWindowHeight: RESTING, windowHeight: RESTING - systemShrink,
    })).toBe(KEYBOARD - NAV_BAR - systemShrink);
  });

  it('never returns a negative padding', () => {
    expect(androidComposerKeyboardBottomPadding({
      keyboardHeight: 60, bottomInset: NAV_BAR, restingWindowHeight: RESTING, windowHeight: RESTING - 300,
    })).toBe(0);
  });
});