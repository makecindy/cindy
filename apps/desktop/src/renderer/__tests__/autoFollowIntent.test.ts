/**
 * autoFollowIntent 单测 — auto-follow 解除 / 恢复判定纯函数。
 *
 * 背景(2026-07 用户实报):流式输出期间上滚一格滚轮(~40px)距底仍 < 100px
 * 阈值,被距离判定认为「在底」,下一帧又被 pinToBottom 钉回,必须快速滚多行
 * 才能停止自动滚动。修复后解除跟随走事件意图(wheel / touch / 键盘),恢复
 * 跟随走「距离 + 向下方向」。三个纯函数的规则见 autoFollowIntent.ts 模块注释。
 */
import { describe, expect, it } from 'vitest';

import {
  resolveLastUserMessageObservation,
  resolveNearBottomOnScroll,
  resolveRenderPinDecision,
  selectTailUserMessageId,
  shouldUnpinOnUpIntent,
  shouldUnpinOnWheel,
  UNPIN_MIN_SCROLLABLE_PX,
} from '../components/chat/autoFollowIntent';

/** 可滚容器的基准几何:内容 2000px,视口 800px。 */
const SCROLLABLE = { scrollHeight: 2000, clientHeight: 800 };

describe('shouldUnpinOnWheel', () => {
  it('向上滚动(deltaY < 0)且容器可滚 → 解除', () => {
    expect(shouldUnpinOnWheel({ deltaX: 0, deltaY: -40, ...SCROLLABLE })).toBe(true);
  });

  it('哪怕只上滚 1px 也解除 — 修复主诉求:一行即停,不看距离阈值', () => {
    expect(shouldUnpinOnWheel({ deltaX: 0, deltaY: -1, ...SCROLLABLE })).toBe(true);
  });

  it('向下滚动(deltaY > 0)→ 不解除', () => {
    expect(shouldUnpinOnWheel({ deltaX: 0, deltaY: 40, ...SCROLLABLE })).toBe(false);
  });

  it('deltaY === 0(纯水平滚动)→ 不解除', () => {
    expect(shouldUnpinOnWheel({ deltaX: -30, deltaY: 0, ...SCROLLABLE })).toBe(false);
  });

  it('水平为主轴的触控板平移(|deltaX| > |deltaY|)→ 不解除,防横滚抖动误伤', () => {
    expect(shouldUnpinOnWheel({ deltaX: -60, deltaY: -3, ...SCROLLABLE })).toBe(false);
    expect(shouldUnpinOnWheel({ deltaX: 60, deltaY: -3, ...SCROLLABLE })).toBe(false);
  });

  it('对角线滚动垂直分量不小于水平分量 → 解除(>= 边界)', () => {
    expect(shouldUnpinOnWheel({ deltaX: 40, deltaY: -40, ...SCROLLABLE })).toBe(true);
  });

  it('容器不可滚(scrollHeight === clientHeight)→ 不解除,避免永久失去跟随', () => {
    expect(
      shouldUnpinOnWheel({ deltaX: 0, deltaY: -40, scrollHeight: 800, clientHeight: 800 }),
    ).toBe(false);
  });

  it('sub-pixel 圆整(差 1px 内)仍视为不可滚', () => {
    expect(
      shouldUnpinOnWheel({
        deltaX: 0,
        deltaY: -40,
        scrollHeight: 800 + UNPIN_MIN_SCROLLABLE_PX,
        clientHeight: 800,
      }),
    ).toBe(false);
  });
});

describe('shouldUnpinOnUpIntent', () => {
  it('容器可滚 → 解除(方向语义由 caller 的事件分支保证)', () => {
    expect(shouldUnpinOnUpIntent(SCROLLABLE)).toBe(true);
  });

  it('容器不可滚 → 不解除', () => {
    expect(shouldUnpinOnUpIntent({ scrollHeight: 800, clientHeight: 800 })).toBe(false);
    expect(
      shouldUnpinOnUpIntent({ scrollHeight: 800 + UNPIN_MIN_SCROLLABLE_PX, clientHeight: 800 }),
    ).toBe(false);
  });
});

describe('resolveNearBottomOnScroll', () => {
  const BASE = { thresholdPx: 100, directionDeadZonePx: 1 };

  it('距底超过阈值 → 一律 false(滚动条拖拽等无 wheel 路径的解除兜底)', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 100,
        scrollDelta: -40,
      }),
    ).toBe(false);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 500,
        scrollDelta: 40,
      }),
    ).toBe(false);
  });

  it('阈值带内 + 原本在跟 → 保持跟随(布局钳位 / 滚动条微拖的被动上移不解除)', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 40,
        scrollDelta: -40,
      }),
    ).toBe(true);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 0,
        scrollDelta: 0,
      }),
    ).toBe(true);
  });

  it('阈值带内 + 已解除 + 上滚事件 → 保持解除(修复核心:意图解除后紧跟的上滚 scroll 事件不得把跟随翻回去)', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 40,
        scrollDelta: -40,
      }),
    ).toBe(false);
  });

  it('阈值带内 + 已解除 + 无明确方向(死区内)→ 保持解除', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 40,
        scrollDelta: 0,
      }),
    ).toBe(false);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 40,
        scrollDelta: 1,
      }),
    ).toBe(false);
  });

  it('阈值带内 + 已解除 + 明确向下 → 恢复跟随', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 40,
        scrollDelta: 2,
      }),
    ).toBe(true);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: false,
        distanceFromBottom: 99,
        scrollDelta: 400,
      }),
    ).toBe(true);
  });
});

describe('resolveRenderPinDecision', () => {
  it('explicit tail send takes ownership from a restored history anchor', () => {
    expect(resolveRenderPinDecision({
      restoring: true,
      newUserSend: true,
      nearBottom: false,
    })).toEqual({ clearRestoring: true, pinToBottom: true });
  });

  it('restored history remains anchored until an explicit user send', () => {
    expect(resolveRenderPinDecision({
      restoring: true,
      newUserSend: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });

  it('keeps ordinary near-bottom auto-follow behavior', () => {
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: false,
      nearBottom: true,
    })).toEqual({ clearRestoring: false, pinToBottom: true });
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });
});

describe('selectTailUserMessageId', () => {
  type Item = { type: 'message'; id: string; role: 'user' | 'assistant' };
  const userMessageId = (item: Item | undefined) =>
    item?.role === 'user' ? item.id : null;

  it('uses the real tail when a bounded window does not cover the end', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: false,
        visibleLastItem: { type: 'message', id: 'old-user', role: 'user' },
        realLastItem: { type: 'message', id: 'new-user', role: 'user' },
        userMessageId,
      }),
    ).toBe('new-user');
  });

  it('ignores an older visible-tail user when the real tail is assistant', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: false,
        visibleLastItem: { type: 'message', id: 'old-user', role: 'user' },
        realLastItem: { type: 'message', id: 'assistant-tail', role: 'assistant' },
        userMessageId,
      }),
    ).toBeNull();
  });

  it('uses the visible tail when the window covers the end', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: true,
        visibleLastItem: { type: 'message', id: 'visible-user', role: 'user' },
        realLastItem: { type: 'message', id: 'visible-user', role: 'user' },
        userMessageId,
      }),
    ).toBe('visible-user');
  });
});

describe('resolveLastUserMessageObservation', () => {
  it('seeds a restored user tail hydrated after mount without treating it as a send', () => {
    expect(
      resolveLastUserMessageObservation({
        restoring: true,
        tailUserMessageId: 'historical-user',
        previousTailUserMessageId: null,
      }),
    ).toEqual({
      baselineUserMessageId: 'historical-user',
      isNewUserSend: false,
    });
  });

  it('still detects a later user send after the restored baseline', () => {
    expect(
      resolveLastUserMessageObservation({
        restoring: true,
        tailUserMessageId: 'new-user',
        previousTailUserMessageId: 'historical-user',
      }),
    ).toEqual({
      baselineUserMessageId: 'historical-user',
      isNewUserSend: true,
    });
  });
});
