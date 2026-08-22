import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 消息列表容器契约:LegendList(替代 FlatList —— 滚动 mount 卡顿的实测解,见 listperf profiling:
// windowSize=21 的大挂载树 p95≈167ms/jank46,换 LegendList 小预渲窗口后 p95≈20ms/jank4)。
// 关键 prop 不可回退:估高 + 小 drawDistance(挂载集小)+ 内置贴底/防跳(替代已删除的手搓 open-settle
// / follow rAF / prepend-settle 锚定机制)。
describe('mobile message list container', () => {
  it('uses LegendList with estimated-size virtualization and built-in chat anchoring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    // 已完全迁出 FlatList:不再出现 FlatList 容器,也不再有其虚拟化专有 prop。
    expect(source).not.toContain('<FlatList');
    expect(source).not.toContain('windowSize={');
    expect(source).not.toContain('getItemLayout={');

    const listStart = source.indexOf('<LegendList');
    expect(listStart).toBeGreaterThan(-1);
    const listSource = source.slice(listStart, source.indexOf('onViewableItemsChanged', listStart));

    // 估高 + 小预渲窗口:挂载集小、mount 帧压进一帧(不可退回大挂载树)。
    expect(listSource).toContain('estimatedItemSize={MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE}');
    expect(listSource).toContain('drawDistance={MOBILE_MESSAGE_DRAW_DISTANCE}');
    // 内置贴底 + prepend 防跳(替代手搓 open-settle / follow rAF / prepend-settle,勿回潮)。
    expect(listSource).toContain('alignItemsAtEnd');
    expect(listSource).toContain('maintainScrollAtEnd');
    expect(listSource).toContain('maintainVisibleContentPosition={{ data: true, size: true }}');
    // cell 含内部 state(展开态 / 手势图 / mermaid·math WebView),关闭回收避免实例错误复用。
    expect(listSource).toContain('recycleItems={false}');
    // 上滑加载:LegendList 近顶阈值触发自动预取(替代手搓的滚动 metric 判定)。
    expect(listSource).toContain('onStartReached={handleStartReached}');
    // 自动预取必须是电平判定(shouldAutoLoadEarlier + 多时机重评估),不许退回只吃 onStartReached
    // 边沿——边沿被业务 guard 吞掉后条件再就绪也等不到下一个边沿(顶部停留永不加载的回归)。
    expect(source).toContain('shouldAutoLoadEarlier({');
    // 冷开允许有限补页,把短初窗上方历史自动补齐；预算耗尽或首项无进展即停止。
    expect(source).toContain('MAX_INITIAL_HISTORY_AUTOFILL_PAGES');
    expect(source).toContain('initialHistoryAutofillRemainingRef.current -= 1');
    // 所有 prepend 在请求期间抑制贴底，成功/空页/失败后延迟一帧释放；generation
    // 防止旧会话请求 settle 后误清新会话 / 新请求状态。
    expect(source).toContain('onLoadEarlier?: () => void | Promise<void>');
    expect(source).toContain('readingOlderRef.current = true');
    expect(source).toContain('Promise.resolve(result).then(releaseReadingOlder, releaseReadingOlder)');
    expect(source).toContain('readingOlderRequestGenerationRef.current === generation');
    // 深链 / 搜索定位本身就是明确的历史浏览意图,后续近顶自动补页无需再拖一下。
    const focusEffectStart = source.indexOf('// 深链/搜索:滚到指定消息');
    const focusEffectEnd = source.indexOf('// 新消息红点', focusEffectStart);
    const focusEffectSource = source.slice(focusEffectStart, focusEffectEnd);
    expect(focusEffectSource).toContain('userScrollForOlderRef.current = true');
    expect(focusEffectSource).toContain('lastAutoLoadEarlierKeyRef.current = null');
  });

  it('protects follow state while imperative scroll and verifies the cold-open anchor', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain('programmaticScrollInFlight: programmaticScrollInFlightRef.current');
    expect(source).toContain('evaluateMobileAnchorVerify({');
    expect(source).toContain('initialAnchorVerifyFrameRef');
    expect(source).toContain('scrollToEndProgrammatically(false)');
    // mVCP 对 data / size 都常开；普通尾部追加与流式 resize 必须先记 settle 安静窗，
    // 两套 verifier 都不能再只依赖 readingOlderRef 判断是否等待。
    expect(source).toContain('mvcpSettleAtRef.current = mobileMvcpSettleDeadline(');
    expect(source).toContain('markMobileMvcpSettle();');
    expect(source).toContain('mobileMessageListKeysSignature(itemKeys)');
    expect(source).toContain('[itemKeysSignature, markMobileMvcpSettle]');
    expect(source).not.toContain('[itemKeys, markMobileMvcpSettle]');
    expect(source.match(/isMobileMvcpSettling\(Date\.now\(\), mvcpSettleAtRef\.current\)/g))
      .toHaveLength(2);
  });

  it('clears stale history intent before verifying an explicit follow-latest request', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const effectStart = source.indexOf('// 「跳到最新」请求');
    const effectEnd = source.indexOf('// 自动加载更早', effectStart);
    const effectSource = source.slice(effectStart, effectEnd);
    const clearHistoryIntentAt = effectSource.indexOf('userScrollForOlderRef.current = false');
    const verifyAt = effectSource.indexOf('runStickToLatestVerify();');

    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(clearHistoryIntentAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(clearHistoryIntentAt);
  });

  it('verifies a manual jump-to-latest after issuing the animated scroll', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const callbackStart = source.indexOf('const scrollToBottom = useCallback');
    const callbackEnd = source.indexOf('const jumpToPreviousUserMessage', callbackStart);
    const callbackSource = source.slice(callbackStart, callbackEnd);
    const scrollAt = callbackSource.indexOf('scrollToEndProgrammatically(true);');
    const verifyAt = callbackSource.indexOf('runStickToLatestVerify();');

    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    expect(scrollAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(scrollAt);
    expect(callbackSource).toContain(
      '}, [runStickToLatestVerify, scrollToEndProgrammatically]);',
    );
  });

  it('waits for an animated follow scroll to settle before issuing non-animated verification retries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const verifyStart = source.indexOf('const runStickToLatestVerify = useCallback');
    const verifyEnd = source.indexOf('// DEV-only:', verifyStart);
    const verifySource = source.slice(verifyStart, verifyEnd);
    const contentSizeStart = source.indexOf('const handleContentSize = useCallback');
    const contentSizeEnd = source.indexOf('// 冷开落底', contentSizeStart);
    const contentSizeSource = source.slice(contentSizeStart, contentSizeEnd);

    expect(verifySource).toContain('mobileFollowVerifyStartDelayMs({');
    expect(verifySource).toContain('followVerifyTimerRef.current = setTimeout');
    expect(contentSizeSource).toContain('if (programmaticAnimatedScrollInFlightRef.current)');
    expect(contentSizeSource.indexOf('if (programmaticAnimatedScrollInFlightRef.current)'))
      .toBeLessThan(contentSizeSource.indexOf('scrollToEndProgrammatically(false)'));
  });

  it('clears stale history intent when a manual downward scroll re-pins at the bottom', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const scrollStart = source.indexOf('// 近底/跟随态迁移');
    const scrollEnd = source.indexOf('// 用户开始拖动', scrollStart);
    const scrollSource = source.slice(scrollStart, scrollEnd);

    expect(scrollStart).toBeGreaterThan(-1);
    expect(scrollEnd).toBeGreaterThan(scrollStart);
    expect(scrollSource).toContain('const wasNearBottom = nearBottomRef.current');
    expect(scrollSource).toContain('if (!wasNearBottom && nearBottom && scrollDelta > 0)');
    expect(scrollSource).toContain('userScrollForOlderRef.current = false');
  });

  it('keeps follow verification enabled for a dead-zone drag that never actually unpins', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const verifyStart = source.indexOf('const runStickToLatestVerify');
    const verifyEnd = source.indexOf('// DEV-only:', verifyStart);
    const verifySource = source.slice(verifyStart, verifyEnd);

    expect(verifyStart).toBeGreaterThan(-1);
    expect(verifyEnd).toBeGreaterThan(verifyStart);
    expect(verifySource).toContain('stickToLatest: nearBottomRef.current');
    expect(verifySource).not.toContain(
      'stickToLatest: nearBottomRef.current && !userScrollForOlderRef.current',
    );
  });

  it('measures every mounted shareable message, including expanded group children', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const readerStart = source.indexOf('const readActuallyVisibleShareableMessageIds');
    const readerEnd = source.indexOf('useEffect(() => {', readerStart);
    const readerSource = source.slice(readerStart, readerEnd);

    expect(source).toContain('shareableMessageViewsRef = useRef(new Map<string, View>())');
    expect(source).toContain('onShareableMessageViewChange?: (clientId: string, view: View | null) => void');
    expect(source).toContain('ref={shareableMessage ? handleShareableMessageViewChange : undefined}');
    expect(readerSource).toContain('shareableMessageViewsRef.current.entries()');
    expect(readerSource).not.toContain("token.item.type !== 'message'");
    expect(source).toContain(
      'itemVisiblePercentThreshold: MESSAGE_LIST_VISIBLE_PERCENT_THRESHOLD',
    );
  });
});
