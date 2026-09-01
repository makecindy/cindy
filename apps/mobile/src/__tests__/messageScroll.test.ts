import { describe, expect, it } from 'vitest';
import {
  buildMobileMessageRenderItems,
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
import {
  buildMessageLoadEarlierAction,
  buildSearchLoadEarlierAction,
  createMobileFollowEndPinState,
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  evaluateMobileAnchorVerify,
  evaluateMobileFollowEndContentSizePin,
  findMobileRenderItemKeyByClientId,
  firstNonEmptyMessageLine,
  isNearMessageListBottom,
  isNearMobileMessageListBottom,
  isNearMessageListTop,
  isMobileMvcpSettling,
  mobileFollowVerifyStartDelayMs,
  mobileMessageListKeysSignature,
  mobileMvcpSettleDeadline,
  MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS,
  MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS,
  MOBILE_ANCHOR_VERIFY_TOLERANCE,
  MOBILE_FOLLOW_END_PIN_HEIGHT_DEAD_ZONE,
  MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW,
  MOBILE_FOLLOW_END_PIN_SUPPRESS_MS,
  MOBILE_FOLLOW_END_PIN_WINDOW_MS,
  MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
  MOBILE_NEAR_BOTTOM_THRESHOLD,
  mobileMessageListEndOffset,
  mobileMessageListBottomPadding,
  mobileMessageListNearBottomThreshold,
  previousUserMessageJumpTarget,
  shouldAutoFollowMessages,
  shouldAutoLoadEarlier,
  shouldShowNewMessageIndicator,
  mobileLoadEarlierPrefetchThreshold,
  mobileMessageListTopPadding,
  mobileTopPaddingCompensationOffset,
  MOBILE_FOLLOW_REPIN_DIRECTION_DEAD_ZONE,
  MOBILE_FOLLOW_UNPIN_DRAG_DEAD_ZONE,
  MOBILE_MVCP_SETTLE_QUIET_MS,
  resolveMobileNearBottomOnScroll,
  shouldUnpinMobileFollowOnDrag,
} from '@/session/messageScroll';

function remoteMessage(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

function toolUse(id: string, toolName: string, input: unknown, seconds: number): RemoteMessage {
  return remoteMessage({
    id,
    role: 'tool_use',
    toolUseId: id,
    content: { toolUseId: id, toolName, input },
    createdAt: at(seconds),
  });
}

function renderItems(messages: readonly RemoteMessage[]): MobileMessageRenderItem[] {
  return buildMobileMessageRenderItems(messages);
}

describe('messageScroll', () => {
  it('treats short content and threshold-close scroll as near bottom', () => {
    expect(isNearMessageListBottom({ contentHeight: 500, offsetY: 0, viewportHeight: 600 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 850, viewportHeight: 100 })).toBe(true);
    expect(isNearMessageListBottom({ contentHeight: 1000, offsetY: 600, viewportHeight: 100 })).toBe(false);
  });

  it('treats a reader at the latest message as near bottom even with composer padding', () => {
    const metrics = {
      contentHeight: 1200,
      offsetY: 1200 - 600 - MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
      viewportHeight: 600,
    };

    expect(MOBILE_NEAR_BOTTOM_THRESHOLD).toBeGreaterThan(MOBILE_MESSAGE_LIST_BOTTOM_PADDING);
    expect(isNearMessageListBottom(metrics)).toBe(false);
    expect(isNearMobileMessageListBottom(metrics)).toBe(true);
  });

  it('uses the measured bottom overlay height when it is larger than the fallback padding', () => {
    expect(mobileMessageListBottomPadding(320)).toBe(320);
    expect(mobileMessageListBottomPadding(80)).toBe(MOBILE_MESSAGE_LIST_BOTTOM_PADDING);
    expect(mobileMessageListNearBottomThreshold(320)).toBe(DEFAULT_NEAR_BOTTOM_THRESHOLD + 320);

    const metrics = {
      contentHeight: 1400,
      offsetY: 1400 - 600 - 320,
      viewportHeight: 600,
    };

    expect(isNearMobileMessageListBottom(metrics)).toBe(false);
    expect(isNearMobileMessageListBottom(metrics, 320)).toBe(true);
  });

  it('computes a deterministic content-end offset for native scroll follow', () => {
    expect(mobileMessageListEndOffset({
      contentHeight: 1800,
      offsetY: 0,
      viewportHeight: 700,
    })).toBe(1100);
    expect(mobileMessageListEndOffset({
      contentHeight: 500,
      offsetY: 0,
      viewportHeight: 700,
    })).toBe(0);
  });

  it('treats top overscroll as the automatic load-earlier trigger range', () => {
    expect(isNearMessageListTop({ offsetY: -20 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 96 })).toBe(true);
    expect(isNearMessageListTop({ offsetY: 120 })).toBe(false);
  });

  it('auto-follows initial load and new messages only when already near bottom', () => {
    expect(shouldAutoFollowMessages({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: true,
    })).toBe(true);
    expect(shouldAutoFollowMessages({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(false);
  });

  it('shows the new-message indicator only for new tail messages while away from bottom', () => {
    expect(shouldShowNewMessageIndicator({
      previousLastKey: null,
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm1',
      wasNearBottom: false,
    })).toBe(false);
    expect(shouldShowNewMessageIndicator({
      previousLastKey: 'm1',
      nextLastKey: 'm2',
      wasNearBottom: false,
    })).toBe(true);
  });

  it('re-exports load-earlier action models for the native renderer', () => {
    expect(buildMessageLoadEarlierAction({
      hasOlderMessages: true,
      loading: false,
      visibleMessageCount: 2,
    })).toMatchObject({
      disabled: false,
      label: '加载更早消息',
      visible: true,
    });

    expect(buildSearchLoadEarlierAction({
      hasHits: false,
      hasOlderMessages: true,
      loading: false,
      query: 'status',
    })).toMatchObject({
      label: '加载更早继续搜索',
      visible: true,
    });
  });

  it('finds the previous user message above the first visible item', () => {
    const items = renderItems([
      remoteMessage({ id: 'u1', role: 'user', content: '\n  first question\nsecond line', createdAt: at(1) }),
      remoteMessage({ id: 'a1', role: 'assistant', content: 'answer', createdAt: at(2) }),
      remoteMessage({ id: 'u2', role: 'user', content: 'second question', createdAt: at(3) }),
      remoteMessage({ id: 'a2', role: 'assistant', content: 'answer 2', createdAt: at(4) }),
    ]);

    expect(firstNonEmptyMessageLine('\n  first question\nsecond line')).toBe('first question');
    expect(previousUserMessageJumpTarget(items, 3)).toMatchObject({
      clientId: 'u2',
      itemKey: 'message-u2',
      preview: 'second question',
    });
    expect(previousUserMessageJumpTarget(items, 1)).toMatchObject({
      clientId: 'u1',
      itemKey: 'message-u1',
      preview: 'first question',
    });
    expect(previousUserMessageJumpTarget(items, 0)).toBeNull();
  });

  it('maps client ids inside folded render items to the top-level scroll target', () => {
    const items = renderItems([
      remoteMessage({ id: 'user', role: 'user', content: 'run tests', createdAt: at(1) }),
      remoteMessage({
        id: 'thinking',
        role: 'thinking',
        content: { text: 'checking commands', durationMs: 1200, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test:mobile' }, 3),
      remoteMessage({ id: 'answer', role: 'assistant', content: 'done', createdAt: at(8) }),
    ]);

    expect(findMobileRenderItemKeyByClientId(items, 'user')).toBe('message-user');
    expect(findMobileRenderItemKeyByClientId(items, 'thinking')).toBe('work-thinking');
    expect(findMobileRenderItemKeyByClientId(items, 'bash-1')).toBe('work-thinking');
    expect(findMobileRenderItemKeyByClientId(items, 'missing')).toBeNull();
  });
});

describe('mobileLoadEarlierPrefetchThreshold', () => {
  it('prefetches about two viewports before reaching the top', () => {
    expect(mobileLoadEarlierPrefetchThreshold(800)).toBe(1600);
    expect(mobileLoadEarlierPrefetchThreshold(931.5)).toBe(1863);
  });

  it('falls back to the legacy 96px threshold when viewport height is unknown', () => {
    expect(mobileLoadEarlierPrefetchThreshold(0)).toBe(96);
    expect(mobileLoadEarlierPrefetchThreshold(Number.NaN)).toBe(96);
    expect(mobileLoadEarlierPrefetchThreshold(-10)).toBe(96);
    // 极小视口也不低于旧默认。
    expect(mobileLoadEarlierPrefetchThreshold(20)).toBe(96);
  });
});

// 「自动加载更早」电平触发判定:回归背景是 LegendList onStartReached 的边沿被业务 guard 吞掉后,
// 用户停在顶部、入口亮着却永远不自动加载(短加载窗口会话冷开即中招)。判定必须是纯电平语义:
// 任一输入翻转到就绪态时重评估即可触发,不依赖「再来一次边沿」。
describe('shouldAutoLoadEarlier', () => {
  const eligible = {
    actionDisabled: false,
    actionVisible: true,
    atEnd: false,
    atStart: true,
    firstItemKey: 'message-a',
    initialAutoFillAllowed: false,
    lastAttemptedFirstItemKey: null,
    nearStart: true,
    userScrolledForOlder: true,
  };

  it('fires when the user rests near the top with the affordance ready', () => {
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('recovers after a swallowed start-reached edge once loading finishes (level semantics)', () => {
    // 上一页在途时到达顶部:disabled 吞掉边沿 → 不触发;
    expect(shouldAutoLoadEarlier({ ...eligible, actionDisabled: true })).toBe(false);
    // 加载结束(disabled 翻 false)重评估:无需新边沿即可续拉。
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('recovers when the affordance lights up while already resting near the top', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, actionVisible: false })).toBe(false);
    expect(shouldAutoLoadEarlier(eligible)).toBe(true);
  });

  it('does not cold-fill when the initial bounded budget is unavailable', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, userScrolledForOlder: false })).toBe(false);
  });

  it('cold-fills a near-start window while the initial bounded budget is available', () => {
    expect(shouldAutoLoadEarlier({
      ...eligible,
      atEnd: true,
      initialAutoFillAllowed: true,
      userScrolledForOlder: false,
    })).toBe(true);
  });

  it('does not cold-fill after the initial window already fills the viewport', () => {
    expect(shouldAutoLoadEarlier({
      ...eligible,
      atEnd: true,
      atStart: false,
      initialAutoFillAllowed: true,
      userScrolledForOlder: false,
    })).toBe(false);
  });

  it('keeps user-driven history prefetch disabled while only pinned at the end', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, atEnd: true, atStart: false })).toBe(false);
  });

  it('loads history after an explicit drag when a short window is both at-start and at-end', () => {
    expect(shouldAutoLoadEarlier({
      ...eligible,
      atEnd: true,
      atStart: true,
      userScrolledForOlder: true,
    })).toBe(true);
  });

  it('allows bounded cold-fill while a short initial window is both near-start and at-end', () => {
    expect(shouldAutoLoadEarlier({
      ...eligible,
      atEnd: true,
      atStart: true,
      initialAutoFillAllowed: true,
      userScrolledForOlder: false,
    })).toBe(true);
  });

  it('does not fire outside the prefetch zone', () => {
    expect(shouldAutoLoadEarlier({ ...eligible, nearStart: false })).toBe(false);
  });

  it('requires progress between attempts to avoid hammering a host that returns no new rows', () => {
    // 上次尝试后首项没变(加载失败 / host cursor 未命中拉回重复页)→ 不自动重试;
    expect(shouldAutoLoadEarlier({ ...eligible, lastAttemptedFirstItemKey: 'message-a' })).toBe(false);
    // prepend 真落地(首项变化)→ 允许级联拉下一页(小页填满预取区);
    expect(shouldAutoLoadEarlier({ ...eligible, lastAttemptedFirstItemKey: 'message-z' })).toBe(true);
    // 空列表无进展信号,不触发。
    expect(shouldAutoLoadEarlier({ ...eligible, firstItemKey: null })).toBe(false);
  });
});

describe('mobileMessageListTopPadding', () => {
  it('clears the absolute top chrome plus a breathing gap', () => {
    expect(mobileMessageListTopPadding(104)).toBe(112);
    expect(mobileMessageListTopPadding(50.4)).toBe(59);
  });

  it('adds nothing when the chrome height is unknown', () => {
    expect(mobileMessageListTopPadding(undefined)).toBe(0);
    expect(mobileMessageListTopPadding(0)).toBe(0);
    expect(mobileMessageListTopPadding(Number.NaN)).toBe(0);
  });
});

describe('mobileTopPaddingCompensationOffset', () => {
  const midReadBase = {
    offsetY: 2400,
    stickToLatest: false,
    preserveVisibleContentPosition: false,
    listVisible: true,
  };

  it('keeps the viewport in place when top padding grows or shrinks mid-read', () => {
    // 连接横幅出现:padding 112→160,视口顺移 +48 保持可见内容不动。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 112, nextTopPadding: 160,
    })).toBe(2448);
    // 横幅消失:反向 -48。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 160, nextTopPadding: 112,
    })).toBe(2352);
  });

  it('clamps the compensated offset at zero', () => {
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, offsetY: 20, previousTopPadding: 160, nextTopPadding: 112,
    })).toBe(0);
  });

  it('skips compensation whenever another positioning mechanism owns the viewport', () => {
    const change = { previousTopPadding: 112, nextTopPadding: 160 };
    // 贴底跟随:contentSize follow 分支自行重锚。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, stickToLatest: true,
    })).toBeNull();
    // preserve 窗口(load-earlier / open-settle):mVCP 锚点自行吸收,手动补偿会双重位移。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, preserveVisibleContentPosition: true,
    })).toBeNull();
    // 列表尚未揭开:揭开路径自己定位。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, ...change, listVisible: false,
    })).toBeNull();
  });

  it('does not compensate at the very top or when padding is unchanged', () => {
    // 停在最顶:让位本来就该把内容推下来给横幅腾位。
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, offsetY: 0, previousTopPadding: 112, nextTopPadding: 160,
    })).toBeNull();
    expect(mobileTopPaddingCompensationOffset({
      ...midReadBase, previousTopPadding: 112, nextTopPadding: 112,
    })).toBeNull();
  });
});

describe('shouldUnpinMobileFollowOnDrag', () => {
  // 可滚容器基准:内容 2000,视口 800;拖动起点 offsetY=1200(内容末端)。
  const metricsAt = (offsetY: number) => ({ contentHeight: 2000, offsetY, viewportHeight: 800 });

  it('拖动中相对起点上移超过死区 → 解除(主诉求:小幅上滑即停,不看近底阈值)', () => {
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true, dragStartOffsetY: 1200, metrics: metricsAt(1191),
    })).toBe(true);
  });

  it('拖动中按住不动 / 死区内抖动 → 不解除', () => {
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true, dragStartOffsetY: 1200, metrics: metricsAt(1200),
    })).toBe(false);
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true, dragStartOffsetY: 1200, metrics: metricsAt(1200 - MOBILE_FOLLOW_UNPIN_DRAG_DEAD_ZONE),
    })).toBe(false);
  });

  it('拖动中向下(offset 增大,含 iOS 底部 bounce)→ 不解除', () => {
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true, dragStartOffsetY: 1200, metrics: metricsAt(1230),
    })).toBe(false);
  });

  it('非拖动期(惯性 / 程序化滚动)→ 不解除', () => {
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: false, dragStartOffsetY: 1200, metrics: metricsAt(1100),
    })).toBe(false);
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true, dragStartOffsetY: null, metrics: metricsAt(1100),
    })).toBe(false);
  });

  it('内容未撑满一屏 → 不解除(解除后无法用「滑回底部」恢复)', () => {
    expect(shouldUnpinMobileFollowOnDrag({
      dragging: true,
      dragStartOffsetY: 40,
      metrics: { contentHeight: 600, offsetY: 0, viewportHeight: 800 },
    })).toBe(false);
  });
});

describe('resolveMobileNearBottomOnScroll', () => {
  // 阈值:96 + 132(无浮层)= 228。内容 2000,视口 800 → end offset 1200,
  // 阈值带 = offsetY > 972。
  const metricsAt = (offsetY: number) => ({ contentHeight: 2000, offsetY, viewportHeight: 800 });

  it('距底超出阈值 + 明确上滑 / 已解除 → false(原有离底解除行为不变)', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(900), scrollDelta: -40,
    })).toBe(false);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false, metrics: metricsAt(500), scrollDelta: 40,
    })).toBe(false);
  });

  it('已在跟 + 距底越线但未上滑 → 保持跟随(发送后内容长高不得解除)', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(900), scrollDelta: 0,
    })).toBe(true);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(500), scrollDelta: 80,
    })).toBe(true);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(500), scrollDelta: -1,
    })).toBe(true);
  });

  it('阈值带内 + 原本在跟 → 保持跟随(贴底期间程序化 scrollToEnd 的增量不改状态)', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(1000), scrollDelta: -20,
    })).toBe(true);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(1200), scrollDelta: 0,
    })).toBe(true);
  });

  it('阈值带内 + 已解除 + 上滑事件 → 保持解除(修复核心:解除后同手势的上滑不得翻回跟随)', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false, metrics: metricsAt(1100), scrollDelta: -30,
    })).toBe(false);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false, metrics: metricsAt(1100), scrollDelta: 0,
    })).toBe(false);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false, metrics: metricsAt(1100), scrollDelta: MOBILE_FOLLOW_REPIN_DIRECTION_DEAD_ZONE,
    })).toBe(false);
  });

  it('阈值带内 + 已解除 + 明确向下 → 恢复跟随', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false, metrics: metricsAt(1100), scrollDelta: 2,
    })).toBe(true);
  });

  it('bottomOverlayHeight 放大阈值(与 isNearMobileMessageListBottom 同口径)', () => {
    // overlay 400 → 阈值 96 + 400 = 496,阈值带 = offsetY > 704。
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(750), scrollDelta: -20, bottomOverlayHeight: 400,
    })).toBe(true);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true, metrics: metricsAt(650), scrollDelta: -20, bottomOverlayHeight: 400,
    })).toBe(false);
  });

  it('内容未撑满一屏 → 恒为跟随', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false,
      metrics: { contentHeight: 600, offsetY: 0, viewportHeight: 800 },
      scrollDelta: -10,
    })).toBe(true);
  });

  it('命令式滚动 settling 时忽略瞬时 metrics', () => {
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: true,
      metrics: metricsAt(500),
      scrollDelta: -700,
      programmaticScrollInFlight: true,
    })).toBe(true);
    expect(resolveMobileNearBottomOnScroll({
      wasNearBottom: false,
      metrics: metricsAt(1200),
      scrollDelta: 300,
      programmaticScrollInFlight: true,
    })).toBe(false);
  });
});

describe('evaluateMobileFollowEndContentSizePin (贴底补滚振荡断路器)', () => {
  const allow = { shouldScroll: true, suppressionStarted: false, trippedNow: false };
  const deny = { shouldScroll: false, suppressionStarted: false, trippedNow: false };
  // A/B 振荡到跳闸:首次评估(900)建立向上方向,首个 1200 仍同向不算翻转,
  // 之后每次交替评估 = 1 次翻转;循环 MAX_REVERSALS + 1 步,最后一步是第
  // MAX_REVERSALS 个翻转,恰好打开断路器。
  const floodUntilTripped = (
    state: ReturnType<typeof createMobileFollowEndPinState>,
    startAt: number,
  ): { decision: ReturnType<typeof evaluateMobileFollowEndContentSizePin>; now: number } => {
    let now = startAt;
    let decision = evaluateMobileFollowEndContentSizePin(state, { now, contentHeight: 900 });
    for (let step = 0; step <= MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW; step += 1) {
      now += 16;
      decision = evaluateMobileFollowEndContentSizePin(state, {
        now,
        contentHeight: step % 2 === 0 ? 1200 : 900,
      });
    }
    return { decision, now };
  };

  it('首次补滚放行并登记高度', () => {
    const state = createMobileFollowEndPinState();
    expect(evaluateMobileFollowEndContentSizePin(state, { now: 1000, contentHeight: 900 }))
      .toEqual(allow);
    expect(state.lastPinnedHeight).toBe(900);
  });

  it('高度死区内的重复回调不放行(浮点/舍入噪声、同值重复)', () => {
    const state = createMobileFollowEndPinState();
    evaluateMobileFollowEndContentSizePin(state, { now: 1000, contentHeight: 900 });
    for (const height of [900, 901, 899, 900 + MOBILE_FOLLOW_END_PIN_HEIGHT_DEAD_ZONE]) {
      expect(evaluateMobileFollowEndContentSizePin(state, { now: 1016, contentHeight: height }))
        .toEqual(deny);
    }
    // 死区噪声不构成方向观察,也不制造假翻转。
    expect(state.reversalTimestamps).toHaveLength(0);
    expect(state.lastObservedHeight).toBe(900);
  });

  it('帧级单调快速增长永不跳闸(快流式/冷开分批渲染是合法路径,review P1 核心)', () => {
    const state = createMobileFollowEndPinState();
    let height = 900;
    let now = 1000;
    for (let index = 0; index < 120; index += 1) {
      now += 16; // 60/s,远超原「补滚频率」阈值也不许跳闸
      height += 24;
      expect(evaluateMobileFollowEndContentSizePin(state, { now, contentHeight: height }))
        .toEqual(allow);
    }
    expect(state.suppressedUntil).toBe(0);
  });

  it('高度收缩(rewind/删消息/折叠)照常放行,单次翻转不跳闸', () => {
    const state = createMobileFollowEndPinState();
    evaluateMobileFollowEndContentSizePin(state, { now: 1000, contentHeight: 2000 });
    // 收缩:方向翻转 1 次,但补滚照常放行。
    expect(evaluateMobileFollowEndContentSizePin(state, { now: 1100, contentHeight: 1400 }))
      .toEqual(allow);
    // 随后恢复流式增长(再翻转 1 次)同样放行。
    expect(evaluateMobileFollowEndContentSizePin(state, { now: 1200, contentHeight: 1424 }))
      .toEqual(allow);
    expect(state.suppressedUntil).toBe(0);
  });

  it('窗口内方向翻转到达上限 → 跳闸:suppressionStarted + 首次 trippedNow,停止放行', () => {
    const state = createMobileFollowEndPinState();
    const { decision, now } = floodUntilTripped(state, 1000);
    expect(decision).toEqual({ shouldScroll: false, suppressionStarted: true, trippedNow: true });
    expect(state.suppressedUntil).toBe(now + MOBILE_FOLLOW_END_PIN_SUPPRESS_MS);
  });

  it('断路期间一律不放行且不延长断路;振荡停息 + 到期后恢复放行', () => {
    const state = createMobileFollowEndPinState();
    const { now: trippedAt } = floodUntilTripped(state, 1000);
    const suppressedUntil = state.suppressedUntil;
    expect(evaluateMobileFollowEndContentSizePin(state, { now: trippedAt + 16, contentHeight: 1200 }))
      .toEqual(deny);
    expect(state.suppressedUntil).toBe(suppressedUntil);
    // 断路期振荡停息 → 窗口滚空;到期后的单调增长恢复放行。
    expect(evaluateMobileFollowEndContentSizePin(state, {
      now: suppressedUntil + 1,
      contentHeight: 1500,
    })).toEqual(allow);
  });

  it('断路期间振荡持续记账:断路一闭合立即重新跳闸,且不再重复报告 trippedNow', () => {
    const state = createMobileFollowEndPinState();
    const { now: trippedAt } = floodUntilTripped(state, 1000);
    // 断路期内继续以帧间隔振荡(每次评估都是翻转,窗口内计数持续爆表)。
    let now = trippedAt;
    let toggle = true;
    while (now < state.suppressedUntil - 16) {
      now += 16;
      expect(evaluateMobileFollowEndContentSizePin(state, {
        now,
        contentHeight: toggle ? 900 : 1200,
      }).shouldScroll).toBe(false);
      toggle = !toggle;
    }
    // 断路到期后的首个翻转:窗口内旧账未清,立刻重新跳闸,但告警不重复。
    const reopened = evaluateMobileFollowEndContentSizePin(state, {
      now: state.suppressedUntil + 1,
      contentHeight: toggle ? 900 : 1200,
    });
    expect(reopened).toEqual({ shouldScroll: false, suppressionStarted: true, trippedNow: false });
  });

  it('稀疏翻转被滚动窗口过滤,永不跳闸(正常阅读/折叠节奏)', () => {
    const state = createMobileFollowEndPinState();
    let now = 1000;
    // 每次翻转间隔超过窗口:计数永远到不了上限。
    for (let index = 0; index < MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW * 3; index += 1) {
      now += MOBILE_FOLLOW_END_PIN_WINDOW_MS + 100;
      const decision = evaluateMobileFollowEndContentSizePin(state, {
        now,
        contentHeight: index % 2 === 0 ? 900 : 1200,
      });
      expect(decision).toEqual(allow);
    }
    expect(state.suppressedUntil).toBe(0);
    // 旧翻转随窗口滚出,计数不累积到上限。
    expect(state.reversalTimestamps.length).toBeLessThan(MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW);
  });

  it('窗口边界:恰好等于 windowStart 的旧翻转被严格剔除', () => {
    const state = createMobileFollowEndPinState();
    evaluateMobileFollowEndContentSizePin(state, { now: 1000, contentHeight: 900 });
    evaluateMobileFollowEndContentSizePin(state, { now: 1016, contentHeight: 1200 });
    // 在 t=2000 制造一次翻转记账(900 ← 1200,方向翻转)。
    evaluateMobileFollowEndContentSizePin(state, { now: 2000, contentHeight: 900 });
    expect(state.reversalTimestamps).toEqual([2000]);
    // 下一次翻转发生在 t=3000:windowStart = 2000,`at > windowStart` 为 false,
    // t=2000 的旧翻转被剔除,窗口内只剩本次。
    evaluateMobileFollowEndContentSizePin(state, { now: 3000, contentHeight: 1200 });
    expect(state.reversalTimestamps).toEqual([3000]);
  });
});

describe('evaluateMobileAnchorVerify (落底校验/补滚有界重试环——冷开锚定与贴底跟随共用同一判定)', () => {
  // 视口 800,内容 2000 → endOffset = 1200。
  const metricsAt = (offsetY: number) => ({ contentHeight: 2000, offsetY, viewportHeight: 800 });
  const baseInput = {
    attempts: 0,
    listVisible: true,
    preserveVisibleContentPosition: false,
    stickToLatest: true,
    waitRounds: 0,
  };

  it('未处于贴底跟随意图(用户已解除/翻到旧消息)→ 直接 settled,不发起补滚', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, stickToLatest: false, metrics: metricsAt(0),
    })).toBe('settled');
  });

  it('列表尚未可见(如切换会话中)→ 直接 settled', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, listVisible: false, metrics: metricsAt(0),
    })).toBe('settled');
  });

  it('已落在容差带内 → settled(容差边界 offsetY === endOffset - TOLERANCE 视为已达)', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: metricsAt(1200),
    })).toBe('settled');
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: metricsAt(1200 - MOBILE_ANCHOR_VERIFY_TOLERANCE),
    })).toBe('settled');
  });

  it('偏移仍差着容差带 → retry(容差边界外 1px 即触发重试)', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: metricsAt(1200 - MOBILE_ANCHOR_VERIFY_TOLERANCE - 1),
    })).toBe('retry');
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: metricsAt(0),
    })).toBe('retry');
  });

  it('重试次数达到上限后仍未落底 → give-up(不无限重试)', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, attempts: MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS, metrics: metricsAt(0),
    })).toBe('give-up');
    // 上限前一次仍是 retry。
    expect(evaluateMobileAnchorVerify({
      ...baseInput, attempts: MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS - 1, metrics: metricsAt(0),
    })).toBe('retry');
  });

  it('mVCP 仍开着(preserveVisibleContentPosition)→ wait,不在其吸收滚动的窗口内瞎重试', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, preserveVisibleContentPosition: true, metrics: metricsAt(0),
    })).toBe('wait');
  });

  it('原生 metrics 尚未结算(contentHeight/viewportHeight <= 0)→ wait,而非误判为已落空', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: { contentHeight: 0, offsetY: 0, viewportHeight: 800 },
    })).toBe('wait');
    expect(evaluateMobileAnchorVerify({
      ...baseInput, metrics: { contentHeight: 2000, offsetY: 0, viewportHeight: 0 },
    })).toBe('wait');
  });

  it('等待轮数达到上限仍无有效 metrics/仍在 mVCP 中 → give-up(不无限期挂着)', () => {
    expect(evaluateMobileAnchorVerify({
      ...baseInput,
      preserveVisibleContentPosition: true,
      waitRounds: MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS,
      metrics: metricsAt(0),
    })).toBe('give-up');
    // 上限前一轮仍是 wait。
    expect(evaluateMobileAnchorVerify({
      ...baseInput,
      preserveVisibleContentPosition: true,
      waitRounds: MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS - 1,
      metrics: metricsAt(0),
    })).toBe('wait');
  });
});

describe('mobile mVCP settle quiet window', () => {
  it('keeps verification waiting through the quiet window after a data or size change', () => {
    const settleAt = mobileMvcpSettleDeadline(0, 1_000);
    expect(settleAt).toBe(1_000 + MOBILE_MVCP_SETTLE_QUIET_MS);
    expect(isMobileMvcpSettling(1_000, settleAt)).toBe(true);
    expect(isMobileMvcpSettling(settleAt - 1, settleAt)).toBe(true);
    expect(isMobileMvcpSettling(settleAt, settleAt)).toBe(false);
  });

  it('extends an in-flight settle window when streaming content changes again', () => {
    const firstDeadline = mobileMvcpSettleDeadline(0, 1_000);
    const extendedDeadline = mobileMvcpSettleDeadline(firstDeadline, 1_080);
    expect(extendedDeadline).toBe(1_080 + MOBILE_MVCP_SETTLE_QUIET_MS);
  });

  it('treats reused keys as the same list identity even when the items array is new', () => {
    expect(mobileMessageListKeysSignature(['u1', 'a1'])).toBe(
      mobileMessageListKeysSignature(['u1', 'a1']),
    );
    expect(mobileMessageListKeysSignature(['u1', 'a1'])).not.toBe(
      mobileMessageListKeysSignature(['u1', 'a1', 'a2']),
    );
  });
});

describe('mobileFollowVerifyStartDelayMs (动画贴底完成后再启动 verifier)', () => {
  it('动画仍在 settle 窗口内时返回剩余等待时间', () => {
    expect(mobileFollowVerifyStartDelayMs({
      animatedScrollInFlight: true,
      now: 600,
      settleAt: 1400,
    })).toBe(800);
  });

  it('非动画、已结束或时钟已越过 settle 时立即校验', () => {
    expect(mobileFollowVerifyStartDelayMs({
      animatedScrollInFlight: false,
      now: 600,
      settleAt: 1400,
    })).toBe(0);
    expect(mobileFollowVerifyStartDelayMs({
      animatedScrollInFlight: true,
      now: 1400,
      settleAt: 1400,
    })).toBe(0);
    expect(mobileFollowVerifyStartDelayMs({
      animatedScrollInFlight: true,
      now: 1500,
      settleAt: 1400,
    })).toBe(0);
  });
});
