import { describe, expect, it } from 'vitest';
import {
  COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD,
  COMPOSER_RESIZE_DISMISS_PULL_THRESHOLD,
  COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD,
  COMPOSER_RESIZE_TOP_RESERVED_HEIGHT,
  applyComposerResizeDrag,
  composerCollapseProgress,
  buildComposerResizeGestureConfig,
  buildComposerResizeTouchHandlers,
  computeComposerResizeBounds,
  resolveComposerInputHeight,
  settleComposerResizeDrag,
  shouldClaimComposerResizeDrag,
  shouldDismissComposerOnRelease,
} from '@/session/composerResize';

const bounds = { minContentHeight: 28, maxContentHeight: 400 };

describe('resolveComposerInputHeight', () => {
  it('keeps the legacy auto-grow behavior when no user height is set', () => {
    // 回归:激活态 scrollEnabled 恒 true(不再依赖 onContentSizeChange 测量,
    // RN 新架构下该回调漏报会让开关卡死在 false,超限后光标区域不可见)。
    expect(resolveComposerInputHeight({
      contentHeight: 120,
      userContentHeight: null,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'auto',
      visibleContentHeight: 120,
      scrollEnabled: true,
    });
  });

  it('keeps inner scroll on even when the measured content height is stale at one line', () => {
    // 复现原 bug 的场景:内容实际已超上限,但测量回调漏报、contentHeight 停在单行——
    // 开关不得再依赖测量值。
    expect(resolveComposerInputHeight({
      contentHeight: 28,
      userContentHeight: null,
      autoMaxContentHeight: 270,
      bounds,
    }).scrollEnabled).toBe(true);
  });

  it('caps auto mode at the auto max and enables inner scroll beyond it', () => {
    expect(resolveComposerInputHeight({
      contentHeight: 300,
      userContentHeight: null,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'auto',
      visibleContentHeight: 270,
      scrollEnabled: true,
    });
  });

  it('never renders below the single-line height in auto mode', () => {
    expect(resolveComposerInputHeight({
      contentHeight: 0,
      userContentHeight: null,
      autoMaxContentHeight: 270,
      bounds,
    }).visibleContentHeight).toBe(28);
  });

  it('pins the input to the user height in manual mode regardless of content', () => {
    expect(resolveComposerInputHeight({
      contentHeight: 40,
      userContentHeight: 200,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'manual',
      visibleContentHeight: 200,
      scrollEnabled: true,
    });
  });

  it('scrolls inside manual mode when content exceeds the pinned height', () => {
    expect(resolveComposerInputHeight({
      contentHeight: 320,
      userContentHeight: 120,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'manual',
      visibleContentHeight: 120,
      scrollEnabled: true,
    });
  });

  it('re-clamps a remembered manual height when bounds shrink (e.g. keyboard opens)', () => {
    expect(resolveComposerInputHeight({
      contentHeight: 40,
      userContentHeight: 500,
      autoMaxContentHeight: 270,
      bounds: { minContentHeight: 28, maxContentHeight: 240 },
    }).visibleContentHeight).toBe(240);
  });

  it('collapses to the single-line height in the idle capsule regardless of manual height', () => {
    // 简洁态一律单行:manual 200 也收到单行,记忆保留(mode 仍是 manual)。
    expect(resolveComposerInputHeight({
      collapsed: true,
      contentHeight: 50,
      userContentHeight: 200,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'manual',
      visibleContentHeight: 28,
      scrollEnabled: true,
    });
  });

  it('collapses multi-line auto content to the single-line height in the idle capsule', () => {
    // 点别处收键盘与下拉收起结果一致:多行草稿的简洁态也只有一行。
    expect(resolveComposerInputHeight({
      collapsed: true,
      contentHeight: 72,
      userContentHeight: null,
      autoMaxContentHeight: 270,
      bounds,
    })).toEqual({
      mode: 'auto',
      visibleContentHeight: 28,
      scrollEnabled: true,
    });
  });

  it('does not collapse the manual height while the card is active', () => {
    expect(resolveComposerInputHeight({
      collapsed: false,
      contentHeight: 50,
      userContentHeight: 200,
      autoMaxContentHeight: 270,
      bounds,
    }).visibleContentHeight).toBe(200);
  });
});

describe('applyComposerResizeDrag', () => {
  it('grows when dragging the top grabber upwards (negative translation)', () => {
    expect(applyComposerResizeDrag({
      startContentHeight: 100,
      translationY: -80,
      bounds,
    })).toBe(180);
  });

  it('shrinks when dragging downwards and clamps at the single-line floor', () => {
    expect(applyComposerResizeDrag({
      startContentHeight: 100,
      translationY: 300,
      bounds,
    })).toBe(28);
  });

  it('clamps at the available-space ceiling', () => {
    expect(applyComposerResizeDrag({
      startContentHeight: 380,
      translationY: -200,
      bounds,
    })).toBe(400);
  });
});

describe('settleComposerResizeDrag', () => {
  it('returns the dragged height when released in the middle of the range', () => {
    expect(settleComposerResizeDrag({ draggedContentHeight: 180, contentHeight: 28, bounds })).toBe(180);
  });

  it('snaps back to auto mode when released near the single-line height with single-line content', () => {
    expect(settleComposerResizeDrag({
      draggedContentHeight: bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD,
      contentHeight: bounds.minContentHeight,
      bounds,
    })).toBeNull();
  });

  it('pins multi-line content dragged to the bottom at the single-line height', () => {
    // 拖到底时 dismiss 会同时收键盘;钉住单行保证收起后的简洁态不会按 auto
    // 弹回完整内容高度(「拖小再收起」不能反而变大)。
    expect(settleComposerResizeDrag({
      draggedContentHeight: bounds.minContentHeight,
      contentHeight: 72,
      bounds,
    })).toBe(bounds.minContentHeight);
  });

  it('keeps manual mode just above the snap threshold', () => {
    expect(settleComposerResizeDrag({
      draggedContentHeight: bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD + 1,
      contentHeight: 28,
      bounds,
    })).toBe(bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD + 1);
  });
});

describe('shouldDismissComposerOnRelease', () => {
  it('dismisses when pulling down at single-line height even though the height never moved', () => {
    expect(shouldDismissComposerOnRelease({
      bounds,
      draggedContentHeight: bounds.minContentHeight,
      translationY: COMPOSER_RESIZE_DISMISS_PULL_THRESHOLD,
    })).toBe(true);
  });

  it('dismisses when dragging back down from a tall manual height to the snap zone', () => {
    // 覆盖多行内容场景:输入框虽收不到内容高度以下,键盘必须能这样收起。
    expect(shouldDismissComposerOnRelease({
      bounds,
      draggedContentHeight: bounds.minContentHeight,
      translationY: 180,
    })).toBe(true);
  });

  it('does not dismiss on a short downward pull below the threshold', () => {
    expect(shouldDismissComposerOnRelease({
      bounds,
      draggedContentHeight: bounds.minContentHeight,
      translationY: COMPOSER_RESIZE_DISMISS_PULL_THRESHOLD - 1,
    })).toBe(false);
  });

  it('does not dismiss when released above the snap zone', () => {
    expect(shouldDismissComposerOnRelease({
      bounds,
      draggedContentHeight: bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD + 1,
      translationY: 200,
    })).toBe(false);
  });

  it('does not dismiss when dragging upwards', () => {
    expect(shouldDismissComposerOnRelease({
      bounds,
      draggedContentHeight: bounds.minContentHeight,
      translationY: -40,
    })).toBe(false);
  });
});

describe('computeComposerResizeBounds', () => {
  it('limits the ceiling to the space above the keyboard minus the reserved top area', () => {
    const result = computeComposerResizeBounds({
      windowHeight: 926,
      keyboardHeight: 300,
      singleLineContentHeight: 28,
      autoMaxContentHeight: 270,
      composerChromeHeight: 34,
    });
    expect(result.minContentHeight).toBe(28);
    expect(result.maxContentHeight).toBe(926 - 300 - COMPOSER_RESIZE_TOP_RESERVED_HEIGHT - 34);
  });

  it('never returns a ceiling below the auto max so manual stays a superset of auto', () => {
    const result = computeComposerResizeBounds({
      windowHeight: 568,
      keyboardHeight: 300,
      singleLineContentHeight: 28,
      autoMaxContentHeight: 270,
      composerChromeHeight: 34,
    });
    expect(result.maxContentHeight).toBe(270);
  });

  it('offers more room when the keyboard is hidden', () => {
    const withKeyboard = computeComposerResizeBounds({
      windowHeight: 812,
      keyboardHeight: 336,
      singleLineContentHeight: 28,
      autoMaxContentHeight: 270,
      composerChromeHeight: 34,
    });
    const withoutKeyboard = computeComposerResizeBounds({
      windowHeight: 812,
      keyboardHeight: 0,
      singleLineContentHeight: 28,
      autoMaxContentHeight: 270,
      composerChromeHeight: 34,
    });
    expect(withoutKeyboard.maxContentHeight).toBeGreaterThan(withKeyboard.maxContentHeight);
  });

  it('falls back to sane defaults when dimensions are not ready', () => {
    const result = computeComposerResizeBounds({
      windowHeight: 0,
      keyboardHeight: Number.NaN,
      singleLineContentHeight: 28,
      autoMaxContentHeight: 270,
      composerChromeHeight: 34,
    });
    expect(result.minContentHeight).toBe(28);
    expect(result.maxContentHeight).toBeGreaterThan(270);
  });
});

describe('shouldClaimComposerResizeDrag', () => {
  it('claims a vertical drag beyond the activation threshold', () => {
    expect(shouldClaimComposerResizeDrag({ dx: 0, dy: COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD + 1 })).toBe(true);
    expect(shouldClaimComposerResizeDrag({ dx: 1, dy: -(COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD + 1) })).toBe(true);
  });

  it('lets taps below the threshold pass through', () => {
    expect(shouldClaimComposerResizeDrag({ dx: 0, dy: COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD })).toBe(false);
    expect(shouldClaimComposerResizeDrag({ dx: 0, dy: 0 })).toBe(false);
  });

  it('leaves horizontal-dominant swipes to outer containers', () => {
    expect(shouldClaimComposerResizeDrag({ dx: 20, dy: 10 })).toBe(false);
    expect(shouldClaimComposerResizeDrag({ dx: -20, dy: -10 })).toBe(false);
  });
});

describe('buildComposerResizeGestureConfig', () => {
  const noopCallbacks = { onEnd: () => {}, onGrant: () => {}, onMove: () => {} };

  it('claims vertical drags in the capture phase so an ancestor ScrollView cannot start scrolling first', () => {
    const config = buildComposerResizeGestureConfig(noopCallbacks);
    const verticalDrag = { dx: 0, dy: 12 };
    expect(config.onMoveShouldSetPanResponderCapture(null, verticalDrag)).toBe(true);
    expect(config.onMoveShouldSetPanResponder(null, verticalDrag)).toBe(true);
  });

  it('claims the responder at touch-down so keyboardShouldPersistTaps="handled" ancestors cannot steal it', () => {
    // 外壳 ScrollView 在键盘弹出时会于 touch-start 抢占非输入框触摸(收键盘
    // 逻辑),grabber 必须在 bubble 起点先认领,否则 move 认领永远不被询问。
    const config = buildComposerResizeGestureConfig(noopCallbacks);
    expect(config.onStartShouldSetPanResponder()).toBe(true);
  });

  it('refuses termination requests so an ancestor ScrollView cannot steal the drag midway', () => {
    const config = buildComposerResizeGestureConfig(noopCallbacks);
    expect(config.onPanResponderTerminationRequest()).toBe(false);
  });

  it('routes grant / move / release / terminate into the resize callbacks with the gesture dy', () => {
    const calls: string[] = [];
    const config = buildComposerResizeGestureConfig({
      onEnd: (translationY) => calls.push(`end:${translationY}`),
      onGrant: () => calls.push('grant'),
      onMove: (translationY) => calls.push(`move:${translationY}`),
    });
    config.onPanResponderGrant();
    config.onPanResponderMove(null, { dx: 0, dy: -40 });
    config.onPanResponderRelease(null, { dx: 0, dy: -40 });
    config.onPanResponderTerminate(null, { dx: 0, dy: 8 });
    expect(calls).toEqual(['grant', 'move:-40', 'end:-40', 'end:8']);
  });
});

describe('buildComposerResizeTouchHandlers', () => {
  it('reports touch-down immediately and clears on end / cancel', () => {
    const calls: boolean[] = [];
    const handlers = buildComposerResizeTouchHandlers((active) => calls.push(active));
    handlers.onTouchStart();
    handlers.onTouchEnd();
    handlers.onTouchStart();
    handlers.onTouchCancel();
    expect(calls).toEqual([true, false, true, false]);
  });
});

 describe('composerCollapseProgress', () => {
  it('keeps controls visible until the editor has shrunk to one line', () => {
    expect(composerCollapseProgress({ bounds, startContentHeight: 100, translationY: 50 })).toBe(0);
    expect(composerCollapseProgress({ bounds, startContentHeight: 100, translationY: 72 })).toBe(0);
  });
  it('folds short composers continuously and reverses when the finger moves back', () => {
    const progress = (translationY: number) => composerCollapseProgress({ bounds, startContentHeight: 28, translationY });
    expect([0, 6, 12, 24, 12, 0, -10].map(progress)).toEqual([0, 0.25, 0.5, 1, 0.5, 0, 0]);
    expect(progress(200)).toBe(1);
  });
});
