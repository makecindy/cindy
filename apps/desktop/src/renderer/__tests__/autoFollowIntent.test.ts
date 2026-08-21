/**
 * autoFollowIntent 单测 — auto-follow 解除 / 恢复判定纯函数。
 *
 * 背景(2026-07 用户实报):流式输出期间上滚一格滚轮(~40px)距底仍 < 100px
 * 阈值,被距离判定认为「在底」,下一帧又被 pinToBottom 钉回,必须快速滚多行
 * 才能停止自动滚动。修复后解除跟随走事件意图(wheel / touch / 键盘),恢复
 * 跟随走「距离 + 向下方向」。三个纯函数的规则见 autoFollowIntent.ts 模块注释。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectKnownUserMessageIds,
  findLastMatching,
  findLastMatchingId,
  resolveEffectiveNearBottom,
  resolveLastUserMessageObservation,
  bumpSendFollowCancelGeneration,
  readSendFollowCancelGeneration,
  shouldApplyFollowLatestRequest,
  shouldBumpSendFollowCancelOnScroll,
  shouldCommitFollowLatestRequest,
  tryRequestFollowLatest,
  readFollowLatestRequestKey,
  resolveNearBottomOnScroll,
  resolveRenderPinDecision,
  resolveSendWindowHandoff,
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

  it('距底超过阈值 + 明确上滚 / 已解除 → false(滚动条拖拽等无 wheel 路径的解除兜底)', () => {
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

  it('已在跟 + 距底越线但未上滚 → 保持跟随(发送后内容长高 / 迟到 pin 的 scroll 不得解除)', () => {
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 400,
        scrollDelta: 0,
      }),
    ).toBe(true);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 400,
        scrollDelta: 80,
      }),
    ).toBe(true);
    expect(
      resolveNearBottomOnScroll({
        ...BASE,
        wasNearBottom: true,
        distanceFromBottom: 400,
        scrollDelta: -1,
      }),
    ).toBe(true);
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
      sentFromThisRenderer: true,
      nearBottom: false,
    })).toEqual({ clearRestoring: true, pinToBottom: true });
  });

  it('restored history remains anchored until an explicit user send', () => {
    expect(resolveRenderPinDecision({
      restoring: true,
      newUserSend: false,
      sentFromThisRenderer: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });

  it('keeps ordinary near-bottom auto-follow behavior', () => {
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: false,
      sentFromThisRenderer: false,
      nearBottom: true,
    })).toEqual({ clearRestoring: false, pinToBottom: true });
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: false,
      sentFromThisRenderer: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });

  // #2194: IM 渠道 / 手机端 / 定时任务注入的 user 消息没有本端发送意图，
  // 不应夺走视口——按普通新内容处理（贴底才跟随）。
  it('externally injected user message does not steal a scrolled-up viewport', () => {
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: true,
      sentFromThisRenderer: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });

  it('externally injected user message still follows while near the bottom', () => {
    expect(resolveRenderPinDecision({
      restoring: false,
      newUserSend: true,
      sentFromThisRenderer: false,
      nearBottom: true,
    })).toEqual({ clearRestoring: false, pinToBottom: true });
  });

  it('externally injected user message does not take ownership from a restored anchor', () => {
    expect(resolveRenderPinDecision({
      restoring: true,
      newUserSend: true,
      sentFromThisRenderer: false,
      nearBottom: false,
    })).toEqual({ clearRestoring: false, pinToBottom: false });
  });
});

describe('selectTailUserMessageId', () => {
  type Item = { type: 'message'; id: string; role: 'user' | 'assistant' };
  const userMessageId = (item: Item | undefined) =>
    item?.role === 'user' ? item.id : null;
  const oldUser: Item = { type: 'message', id: 'old-user', role: 'user' };
  const newUser: Item = { type: 'message', id: 'new-user', role: 'user' };
  const assistant: Item = { type: 'message', id: 'assistant-tail', role: 'assistant' };

  it('uses the real tail when a bounded window does not cover the end', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: false,
        visibleItems: [oldUser],
        allItems: [oldUser, newUser],
        userMessageId,
      }),
    ).toBe('new-user');
  });

  it('walks back past a real assistant tail to the latest user send', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: false,
        visibleItems: [oldUser],
        allItems: [oldUser, newUser, assistant],
        userMessageId,
      }),
    ).toBe('new-user');
  });

  it('ignores an older visible-tail user when the real tail has no later user', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: false,
        visibleItems: [oldUser],
        allItems: [assistant],
        userMessageId,
      }),
    ).toBeNull();
  });

  it('uses the latest visible user even when the covered tail is assistant', () => {
    expect(
      selectTailUserMessageId({
        windowCoversEnd: true,
        visibleItems: [oldUser, newUser, assistant],
        allItems: [oldUser, newUser, assistant],
        userMessageId,
      }),
    ).toBe('new-user');
  });
});

describe('findLastMatchingId', () => {
  it('returns the last matching id walking from the tail', () => {
    expect(
      findLastMatchingId(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        (item) => (item.id === 'c' ? null : item.id),
      ),
    ).toBe('b');
    expect(findLastMatchingId([{ id: 'a' }], () => null)).toBeNull();
    expect(
      findLastMatching(
        [{ id: 'a' }, { id: 'b' }],
        (item) => (item.id === 'b' ? item : null),
      )?.id,
    ).toBe('b');
  });
});

describe('resolveEffectiveNearBottom', () => {
  it('uses the scroll-event decision when the window covers the end', () => {
    expect(
      resolveEffectiveNearBottom({
        windowCoversEnd: true,
        nowNearBottom: true,
        wasNearBottom: false,
      }),
    ).toBe(true);
    expect(
      resolveEffectiveNearBottom({
        windowCoversEnd: true,
        nowNearBottom: false,
        wasNearBottom: true,
      }),
    ).toBe(false);
  });

  it('does not start following at the bottom of a historical slice', () => {
    expect(
      resolveEffectiveNearBottom({
        windowCoversEnd: false,
        nowNearBottom: true,
        wasNearBottom: false,
      }),
    ).toBe(false);
  });

  it('keeps an explicit follow while the window has not yet switched back to the tail', () => {
    expect(
      resolveEffectiveNearBottom({
        windowCoversEnd: false,
        nowNearBottom: true,
        wasNearBottom: true,
      }),
    ).toBe(true);
  });

  it('still drops follow when the user scrolls away during a stale-slice handoff', () => {
    expect(
      resolveEffectiveNearBottom({
        windowCoversEnd: false,
        nowNearBottom: false,
        wasNearBottom: true,
      }),
    ).toBe(false);
  });
});

describe('shouldApplyFollowLatestRequest', () => {
  it('applies only when the completing send still belongs to the visible session', () => {
    expect(shouldApplyFollowLatestRequest('session-a', 'session-a')).toBe(true);
    expect(shouldApplyFollowLatestRequest('session-a', 'session-b')).toBe(false);
  });

  it('ignores a late send after the user left the source session', () => {
    expect(shouldApplyFollowLatestRequest('session-a', 'session-b')).toBe(false);
    expect(shouldApplyFollowLatestRequest(null, 'session-b')).toBe(false);
    expect(shouldApplyFollowLatestRequest('session-a', null)).toBe(false);
    expect(shouldApplyFollowLatestRequest(undefined, 'session-b')).toBe(false);
  });
});

describe('shouldCommitFollowLatestRequest', () => {
  it('commits only when the send still belongs to this session and the user did not scroll away', () => {
    expect(
      shouldCommitFollowLatestRequest({
        sourceSessionId: 'session-a',
        currentSessionId: 'session-a',
        startGeneration: 3,
        currentGeneration: 3,
      }),
    ).toBe(true);
  });

  it('drops a failed-send leftover after the user scrolled or switched sessions', () => {
    expect(
      shouldCommitFollowLatestRequest({
        sourceSessionId: 'session-a',
        currentSessionId: 'session-a',
        startGeneration: 3,
        currentGeneration: 4,
      }),
    ).toBe(false);
    expect(
      shouldCommitFollowLatestRequest({
        sourceSessionId: 'session-a',
        currentSessionId: 'session-b',
        startGeneration: 3,
        currentGeneration: 3,
      }),
    ).toBe(false);
  });
});

describe('send follow cancel generation', () => {
  it('isolates cancel generation per session so another pane cannot cancel this send', () => {
    const aStart = readSendFollowCancelGeneration('session-a');
    const bStart = readSendFollowCancelGeneration('session-b');
    bumpSendFollowCancelGeneration('session-b');
    expect(readSendFollowCancelGeneration('session-a')).toBe(aStart);
    expect(readSendFollowCancelGeneration('session-b')).toBe(bStart + 1);
  });

  it('bumps on scrollbar unpin and continued user up-scroll, not on content growth while following', () => {
    expect(
      shouldBumpSendFollowCancelOnScroll({
        wasNearBottom: true,
        effectiveNearBottom: false,
        scrollDelta: -40,
        directionDeadZonePx: 2,
      }),
    ).toBe(true);
    expect(
      shouldBumpSendFollowCancelOnScroll({
        wasNearBottom: false,
        effectiveNearBottom: false,
        scrollDelta: -40,
        directionDeadZonePx: 2,
      }),
    ).toBe(true);
    expect(
      shouldBumpSendFollowCancelOnScroll({
        wasNearBottom: true,
        effectiveNearBottom: true,
        scrollDelta: -1,
        directionDeadZonePx: 2,
      }),
    ).toBe(false);
  });
});

describe('tryRequestFollowLatest', () => {
  it('bumps only the source session when generation is unchanged', () => {
    const sessionA = `follow-a-${Date.now()}`;
    const sessionB = `follow-b-${Date.now()}`;
    const startA = readSendFollowCancelGeneration(sessionA);
    expect(
      tryRequestFollowLatest({
        sourceSessionId: sessionA,
        currentSessionId: sessionA,
        startGeneration: startA,
      }),
    ).toBe(true);
    expect(readFollowLatestRequestKey(sessionA)).toBe(1);
    expect(readFollowLatestRequestKey(sessionB)).toBe(0);
    bumpSendFollowCancelGeneration(sessionA);
    expect(
      tryRequestFollowLatest({
        sourceSessionId: sessionA,
        currentSessionId: sessionA,
        startGeneration: startA,
      }),
    ).toBe(false);
    expect(readFollowLatestRequestKey(sessionA)).toBe(1);
  });

  it('does not bump session A when the visible session is already B', () => {
    const sessionA = `follow-switch-a-${Date.now()}`;
    const sessionB = `follow-switch-b-${Date.now()}`;
    const startA = readSendFollowCancelGeneration(sessionA);
    expect(
      tryRequestFollowLatest({
        sourceSessionId: sessionA,
        currentSessionId: sessionB,
        startGeneration: startA,
      }),
    ).toBe(false);
    expect(readFollowLatestRequestKey(sessionA)).toBe(0);
    expect(readFollowLatestRequestKey(sessionB)).toBe(0);
  });
});

describe('resolveSendWindowHandoff', () => {
  it('local send leaves any anchored window so later tail items keep following', () => {
    expect(
      resolveSendWindowHandoff({
        isNewUserSend: true,
        sentFromThisRenderer: true,
        hasWindowAnchor: true,
        windowCoversEnd: true,
      }),
    ).toEqual({ clearWindowAnchor: true, deferPinToNextRender: false });
    expect(
      resolveSendWindowHandoff({
        isNewUserSend: true,
        sentFromThisRenderer: true,
        hasWindowAnchor: true,
        windowCoversEnd: false,
      }),
    ).toEqual({ clearWindowAnchor: true, deferPinToNextRender: true });
  });

  it('does not touch the default tail window or an external injection', () => {
    expect(
      resolveSendWindowHandoff({
        isNewUserSend: true,
        sentFromThisRenderer: true,
        hasWindowAnchor: false,
        windowCoversEnd: true,
      }),
    ).toEqual({ clearWindowAnchor: false, deferPinToNextRender: false });
    expect(
      resolveSendWindowHandoff({
        isNewUserSend: true,
        sentFromThisRenderer: false,
        hasWindowAnchor: true,
        windowCoversEnd: false,
      }),
    ).toEqual({ clearWindowAnchor: false, deferPinToNextRender: false });
    expect(
      resolveSendWindowHandoff({
        isNewUserSend: false,
        sentFromThisRenderer: true,
        hasWindowAnchor: true,
        windowCoversEnd: true,
      }),
    ).toEqual({ clearWindowAnchor: false, deferPinToNextRender: false });
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

  it('treats a rollback to a previously seen user tail as baseline, not a new send', () => {
    expect(
      resolveLastUserMessageObservation({
        restoring: false,
        tailUserMessageId: 'user-1',
        previousTailUserMessageId: 'user-2',
        knownUserMessageIds: new Set(['user-1', 'user-2']),
      }),
    ).toEqual({
      baselineUserMessageId: 'user-1',
      isNewUserSend: false,
    });
  });

  it('does not treat remount rewind to an older already-loaded user as a send', () => {
    const messages = [
      { role: 'user' as const, clientId: 'user-1' },
      { role: 'assistant' as const, clientId: 'a1' },
      { role: 'user' as const, clientId: 'user-2' },
    ];
    const known = collectKnownUserMessageIds(messages, (message) =>
      message.role === 'user' ? message.clientId : null,
    );
    expect(known).toEqual(new Set(['user-1', 'user-2']));
    expect(
      resolveLastUserMessageObservation({
        restoring: false,
        tailUserMessageId: 'user-1',
        previousTailUserMessageId: 'user-2',
        knownUserMessageIds: known,
      }),
    ).toEqual({
      baselineUserMessageId: 'user-1',
      isNewUserSend: false,
    });
  });
});

describe('MessageStream send-window handoff wiring', () => {
  it('clears any anchored window on a local send and only defers pin for stale slices', () => {
    const source = readFileSync(
      resolve(__dirname, '../components/chat/MessageStream.tsx'),
      'utf8',
    );
    expect(source).toContain('resolveSendWindowHandoff({');
    expect(source).toContain('if (windowHandoff.clearWindowAnchor)');
    expect(source).toContain('if (decision.pinToBottom && !windowHandoff.deferPinToNextRender)');
    expect(source).not.toContain('realTailUserSendOutsideWindow');
    expect(source).toContain('followLatestRequestKey');
    expect(source).toContain('subscribeFollowLatestRequests');
    expect(source).toContain('readFollowLatestRequestKey(sessionId)');
    expect(source).toContain('pinToBottom();');
    expect(source).toContain('bumpSendFollowCancelGeneration(sessionId)');
    expect(source).toContain('shouldBumpSendFollowCancelOnScroll({');
    expect(source).toContain('knownUserMessageIds: knownUserMessageIdsRef.current');
    expect(source).toContain('collectKnownUserMessageIds(messages,');
    expect(source).toContain('if (!ownsHardwareScrollActions) return;');
    expect(source).toContain(
      'useNavigationKeyListener(clearChipJumpSuppression, ownsHardwareScrollActions)',
    );
    expect(source).toContain('newUserSend: false');
    expect(source).toContain('cancelFocusJump({ consumeDeferredDelete: true });');
  });

  it('session view commits follow-latest only after accept and unchanged scroll generation', () => {
    const source = readFileSync(
      resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
      'utf8',
    );
    expect(source).toContain('tryRequestFollowLatest({');
    expect(source).toContain('requestFollowLatest(sessionId, followStartGeneration)');
    expect(source).toContain(
      'const followStartGeneration = readSendFollowCancelGeneration(sessionId);',
    );
  });

  it('edit-resend and blocked resend request follow-latest through the same owner', () => {
    const source = readFileSync(
      resolve(__dirname, '../components/chat/UserMessageEditBox.tsx'),
      'utf8',
    );
    expect(source).toContain('tryRequestFollowLatest({');
    expect(source).toContain(
      'const followStartGeneration = readSendFollowCancelGeneration(sessionId);',
    );
    expect(source).toContain('if (accepted)');
  });
});
