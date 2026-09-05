import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 消息列表容器契约:LegendList(替代 FlatList —— 滚动 mount 卡顿的实测解,见 listperf profiling:
// windowSize=21 的大挂载树 p95≈167ms/jank46,换 LegendList 小预渲窗口后 p95≈20ms/jank4)。
// 关键 prop 不可回退:估高 + 小 drawDistance(挂载集小)+ iOS 原生 / Android 应用层 prepend 锚定。
describe('mobile message list container', () => {
  it('uses LegendList virtualization with platform-scoped history anchoring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const perfHarness = readFileSync(resolve(process.cwd(), 'app/listperf.tsx'), 'utf8');

    // 已完全迁出 FlatList:不再出现 FlatList 容器,也不再有其虚拟化专有 prop。
    expect(source).not.toContain('<FlatList');
    expect(source).not.toContain('windowSize={');
    expect(source).not.toContain('getItemLayout={');

    const listStart = source.search(/<LegendList\s/);
    expect(listStart).toBeGreaterThan(-1);
    const listEnd = source.indexOf('      />', listStart);
    expect(listEnd).toBeGreaterThan(listStart);
    const listSource = source.slice(listStart, listEnd);

    // 估高 + 小预渲窗口:挂载集小、mount 帧压进一帧(不可退回大挂载树)。
    expect(listSource).toContain('estimatedItemSize={MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE}');
    expect(listSource).toContain('drawDistance={MOBILE_MESSAGE_DRAW_DISTANCE}');
    // 与 main 一致，完整历史从首次挂载起就在列表中；不可退回只挂末尾几条的业务尾窗，
    // 否则短尾窗未撑满首屏时 Android 无法拖动历史。
    expect(listSource).toContain('data={listData}');
    expect(listSource).toContain('key={scrollResetKey}');
    expect(source).not.toContain('listData.slice(');
    expect(source).not.toContain('initialEntryBootstrapActive');
    expect(source).not.toContain('initialScrollOffset={');
    expect(source).not.toContain('MOBILE_INITIAL_TAIL_ITEM_COUNT');
    expect(source).not.toContain('MOBILE_TAIL_REVEAL_ITEM_COUNT');
    expect(listSource).not.toMatch(/\binitialScrollIndex\s*=/);
    // Manual data prepend 不能与 Android native MVCP 并行:它会在 cell 位置提交后异步补
    // offset，中间坐标窗无 cell 而白屏。普通 data / size 变化仍由 LegendList 锚定。
    expect(listSource).toContain('alignItemsAtEnd');
    expect(listSource).toContain('maintainScrollAtEnd');
    expect(listSource).toContain('maintainVisibleContentPosition={historyPrependNativeMvcpDisabled');
    expect(listSource).toContain('? false');
    expect(listSource).toContain(': { data: true, size: true }}');
    expect(source).toContain('mobileHistoryPrependUsesAppOwnedAnchor(');
    expect(source).toContain('MOBILE_HISTORY_PREPEND_USES_APP_OWNED_ANCHOR');
    expect(source).toContain('captureMobileHistoryAnchor(');
    expect(source).toContain('resolveMobileMessageHistoryAnchorOffset(');
    expect(source).toContain('getCurrentHistoryTopOffsetAdjustment()');
    expect(source).toContain('onMetricsChange={handleListMetricsChange}');
    expect(source).toContain('mobileMessageHistoryAnchorIdentity(item as MobileMessageRenderItem)');
    expect(source).toContain('mobileMessageHistoryRowKeyByIdentity(');
    expect(source).toContain('scheduleHistoryAnchorRestore(transaction.generation)');
    const historyRestoreStart = source.indexOf('const scheduleHistoryAnchorRestore = useCallback');
    const historyRestoreStep = source.indexOf('const step = (', historyRestoreStart);
    const historyRestoreSetup = source.slice(historyRestoreStart, historyRestoreStep);
    expect(historyRestoreSetup).toContain('if (historyAnchorVerifyFrameRef.current !== null) return;');
    expect(historyRestoreSetup).not.toContain('cancelAnimationFrame(historyAnchorVerifyFrameRef.current)');
    expect(source).toContain('useLayoutEffect(() => {');
    // 普通 Release/DEV 详情页使用 keyed remount，避免 Fabric 在异构消息树之间回收容器时
    // 重挂仍属于旧父节点的原生 child；listperf 仍可显式做 on/off A/B。
    expect(source).toContain('devRecycleItems = false,');
    expect(source).toContain('const recycleItems = __DEV__ ? devRecycleItems === true : false;');
    expect(perfHarness).toContain("const recycle = params.recycle !== '0';");
    expect(listSource).toContain('recycleItems={recycleItems}');
    expect(listSource).toContain('getItemType={mobileMessageListItemType}');
    expect(source).toContain('useRecyclingState');
    // 可见性必须由 cell 自己订阅。把可见 key 集合放进 React Context 会在每个
    // onViewableItemsChanged 回调里广播给所有已挂载长消息，快滑时造成整窗重渲染、GC 和白屏。
    expect(source).not.toContain('MessageListVisibleKeysContext');
    expect(source).not.toContain('visibleMessageKeys');
    expect(source).toContain("const MESSAGE_LIST_VIEWABILITY_CONFIG_ID = 'message-heavy-content';");
    expect(source).toContain('id: MESSAGE_LIST_VIEWABILITY_CONFIG_ID');
    expect(source).toContain('useViewability<MobileMessageRenderItem>(');
    expect(source).toContain('MESSAGE_LIST_VIEWABILITY_CONFIG_ID,');
    expect(source).toContain('const [isViewable, setIsViewable] = useRecyclingState(false);');
    expect(source).toContain('if (token.key !== itemKeyRef.current) return;');
    expect(source).toContain('maxTextRunInlineFragments: ANDROID_SELECTABLE_TEXT_RUN_MAX_INLINE_FRAGMENTS');
    expect(listSource).toContain('onFirstVisibleItemChanged={handleFirstVisibleItemChangedRef.current}');
    expect(listSource).not.toContain('onViewableItemsChanged=');
    // 上滑加载:LegendList 近顶阈值触发自动预取(替代手搓的滚动 metric 判定)。
    expect(listSource).toContain('onStartReached={handleStartReached}');
    // 自动预取必须是电平判定(shouldAutoLoadEarlier + 多时机重评估),不许退回只吃 onStartReached
    // 边沿——边沿被业务 guard 吞掉后条件再就绪也等不到下一个边沿(顶部停留永不加载的回归)。
    expect(source).toContain('shouldAutoLoadEarlier({');
    expect(source).toContain('MOBILE_SCROLL_HISTORY_EVALUATION_INTERVAL_MS = 64');
    expect(source).toContain('now - lastScrollHistoryEvaluationAtRef.current');
    expect(source).toContain('nativeMetrics.offsetY > MOBILE_ANCHOR_VERIFY_TOLERANCE');
    expect(source).toContain('pendingScrollHistoryMetricsRef.current = nativeMetrics;');
    expect(source).toContain('attemptAutoLoadEarlierRef.current(pendingMetrics ?? undefined);');
    expect(source).toContain('if (hasNewMessagesRef.current === next) return;');
    expect(source).toContain('if (isAwayFromBottomRef.current === next) return;');
    // 冷开只在列表同时贴住 start/end(首屏未填满)时有限补页。
    expect(source).toContain('MAX_INITIAL_HISTORY_AUTOFILL_PAGES');
    expect(source).toContain('const initialAutoFillAllowed = listRevealed');
    expect(source).toContain('atStart: listState.isAtStart');
    expect(source).toContain('listState.isAtStart || nativeAtStart');
    expect(source).toContain('listState.isNearStart || nativeNearStart');
    expect(source).toContain('historyTouchTriggeredRef.current = true');
    // LegendList does not forward every raw touch callback to its native ScrollView. Observe the
    // bubbling gesture on the stable outer frame so a deliberate pull at offset 0 can request a page.
    expect(source).toContain('onTouchStart={handleHistoryTouchStart}');
    expect(source).toContain('onTouchMove={handleHistoryTouchMove}');
    expect(source).toContain('onTouchEnd={handleHistoryTouchEnd}');
    expect(source).toContain('onTouchCancel={handleHistoryTouchCancel}');
    expect(listSource).not.toContain('onTouchMove={handleHistoryTouchMove}');
    expect(source).toContain('if (readingOlderRef.current || queuedLoadEarlierRef.current) return;');
    expect(source).toContain('const firstItemKey = itemKeys[0] ?? null;');
    expect(source).toContain('const historyProgressKey = loadEarlierProgressKey ?? firstItemKey;');
    expect(source).toContain('initialHistoryAutofillRemainingRef.current -= 1');
    // 所有 prepend 在请求、新页提交和锚点恢复期间抑制贴底。Promise settlement 强制
    // 一次 render，layout effect 确认新 cursor 已提交后才允许释放；generation 隔离旧请求。
    expect(source).toContain('onLoadEarlier?: () => void | Promise<void>');
    expect(source).toContain('readingOlderRef.current = true');
    expect(source).toContain('void Promise.resolve(result).then(');
    expect(source).toContain('transaction.promiseSettled = true');
    expect(source).toContain('transaction.startProgressKey !== historyProgressKey');
    expect(source).toContain('transaction.pageCommitted = true');
    expect(source).toContain('transaction.anchorStable = true');
    expect(source).toContain('loadingEarlierRef.current || !transaction.promiseSettled');
    expect(source).toContain('setLoadEarlierEvaluationVersion((version) => version + 1);');
    expect(source).toContain('[attemptAutoLoadEarlier, loadEarlierEvaluationVersion]');
    // 若一页只扩进顶部折叠的 Worked for，事务保位不能改变 main 的连续分页语义：
    // 锚点稳定后绕过一次 near-start 复判继续拉，直到出现可见顶层历史或到头。
    expect(source).toContain('mobileMessageHistoryOnlyExpandedFirstWorkGroup(');
    expect(source).toContain('regroupedHistoryContinuationRef.current = transaction.continueAfterRegroup');
    expect(source).toContain('const continueAfterRegroup = userScrolledForOlder');
    expect(source).toContain('if (continueAfterRegroup) {');
    expect(source).not.toContain('message.historyLoadConfirmation');
    expect(source).toContain('MOBILE_HISTORY_ANCHOR_VERIFY_MAX_FRAMES');
    expect(source).toContain('MOBILE_HISTORY_ANCHOR_VERIFY_MAX_MS');
    expect(source).toContain('Date.now() < currentTransaction.verifyDeadlineAt');
    expect(source).toContain('mobileHistoryAnchorCorrectionStatus(pendingCorrection');
    expect(source).toContain('nativeScrollEventSequenceRef.current += 1');
    expect(source).toContain('const currentOffset = scrollMetricsRef.current.offsetY;');
    expect(source).not.toContain('const currentOffset = listState.scroll;');
    expect(source).not.toContain('if (finalTarget !== null) scrollToOffsetProgrammatically(finalTarget, false);');
    expect(source).toContain('const restoreHistoryAnchorOnce = useCallback');
    expect(source).toContain('restoreHistoryAnchorOnce(transaction.generation)');
    expect(source).toContain('transaction.userControlledAfterCommit = true');
    expect(source).toContain('if (viewportTakenOver) transaction.userControlledDuringRequest = true;');
    expect(source).toContain('if (transaction.userControlledDuringRequest) {');
    // 轻点不是接管视口:touch-start 只代表手指按住 ScrollView。若把它当接管,会取消
    // regroup-only 续拉标记,新页仅展开顶部折叠 Worked for 时用户就被留在顶部干等。
    const touchStartStart = source.indexOf('const handleHistoryTouchStart = useCallback');
    const touchStartEnd = source.indexOf('const maybeTriggerHistoryTouch', touchStartStart);
    const touchStartSource = source.slice(touchStartStart, touchStartEnd);
    expect(touchStartSource).toContain('handoffHistoryPrependToUser(false)');
    const triggerTouchStart = source.indexOf('const maybeTriggerHistoryTouch = useCallback');
    const triggerTouchEnd = source.indexOf('const handleHistoryTouchMove', triggerTouchStart);
    expect(source.slice(triggerTouchStart, triggerTouchEnd)).toContain('handoffHistoryPrependToUser();');
    // 手势接管只在手指/惯性真正持有视口时扣住事务:否则「提交前手势已结束 + 该页无坐标进展」
    // 会永久扣住事务,native MVCP 整段关掉。提交分支必须显式重新武装 handoff,
    // 手势早已结束时才有路径回到锚点校验并收口。
    const maybeFinishStart = source.indexOf('const maybeFinishHistoryPrependTransaction = useCallback');
    const maybeFinishEnd = source.indexOf('const handoffHistoryPrependToUser', maybeFinishStart);
    const maybeFinishSource = source.slice(maybeFinishStart, maybeFinishEnd);
    expect(maybeFinishSource).toContain('transaction.userHandoffPending');
    expect(maybeFinishSource).toContain('isDraggingRef.current');
    expect(maybeFinishSource).toContain('isMomentumScrollingRef.current');
    expect(maybeFinishSource).toContain('historyTouchStartYRef.current !== null');
    expect(source).toContain('transaction.userHandoffPending = true;');
    expect(source).toContain('currentTransaction.userHandoffPending = false;');
    // 直接拖动结束前不发请求，避免远端页在手指仍控制 ScrollView 时落地。
    expect(source).toContain('queuedLoadEarlierRef.current = true');
    expect(source).toContain('setHistoryPrependNativeMvcpDisabled(true)');
    expect(source).toMatch(
      /MOBILE_HISTORY_PREPEND_USES_APP_OWNED_ANCHOR\s+&& !historyPrependNativeMvcpDisabledRef\.current/,
    );
    expect(source).toContain('if (!historyPrependNativeMvcpDisabled) return;');
    expect(source).toContain('flushQueuedLoadEarlier();');
    expect(source).toContain('isMomentumScrollingRef.current');
    expect(listSource).toContain('onMomentumScrollBegin={handleMomentumScrollBegin}');
    expect(listSource).toContain('onMomentumScrollEnd={handleMomentumScrollEnd}');
    const beginLoadEarlierStart = source.indexOf('const beginLoadEarlier = useCallback');
    const beginLoadEarlierEnd = source.indexOf('const flushQueuedLoadEarlier', beginLoadEarlierStart);
    const beginLoadEarlierSource = source.slice(beginLoadEarlierStart, beginLoadEarlierEnd);
    const flushLoadEarlierStart = source.indexOf('const flushQueuedLoadEarlier = useCallback');
    const flushLoadEarlierEnd = source.indexOf('const requestLoadEarlier', flushLoadEarlierStart);
    const flushLoadEarlierSource = source.slice(flushLoadEarlierStart, flushLoadEarlierEnd);
    expect(beginLoadEarlierSource).toContain('if (userScrollForOlderRef.current)');
    expect(beginLoadEarlierSource).toContain('nearBottomRef.current = false');
    expect(flushLoadEarlierSource).toContain('isDraggingRef.current');
    expect(flushLoadEarlierSource).toContain('isMomentumScrollingRef.current');
    expect(flushLoadEarlierSource).toContain('historyTouchStartYRef.current !== null');
    // A second touch while the page is in flight must not reopen follow-to-latest.
    const dragStart = source.indexOf('const handleScrollBeginDrag = useCallback');
    const dragEnd = source.indexOf('const handleScrollEndDrag', dragStart);
    const dragSource = source.slice(dragStart, dragEnd);
    expect(dragSource).not.toContain('readingOlderRef.current = false');
    expect(dragSource).toContain('isMomentumScrollingRef.current = false');
    expect(dragSource).toContain('handoffHistoryPrependToUser();');
    const touchStart = source.indexOf('const handleHistoryTouchStart = useCallback');
    const touchMove = source.indexOf('const maybeTriggerHistoryTouch', touchStart);
    expect(source.slice(touchStart, touchMove)).toContain('isMomentumScrollingRef.current = false');
    const scrollStart = source.indexOf('const handleScroll = useCallback');
    const scrollEnd = source.indexOf('const handleHistoryTouchStart', scrollStart);
    const scrollSource = source.slice(scrollStart, scrollEnd);
    expect(scrollSource.indexOf('if (readingOlderRef.current)'))
      .toBeLessThan(scrollSource.indexOf('resolveMobileNearBottomOnScroll({'));
    expect(scrollSource.slice(
      scrollSource.indexOf('if (readingOlderRef.current)'),
      scrollSource.indexOf('const wasNearBottom'),
    )).toContain('handoffHistoryPrependToUser();');
    expect(scrollSource.slice(
      scrollSource.indexOf('if (readingOlderRef.current)'),
      scrollSource.indexOf('const wasNearBottom'),
    )).toContain('return;');
    expect(scrollSource).toContain('shouldPreserveMobileHistoryBrowseIntent({');
    expect(scrollSource).toContain('historyBrowseIntent: userScrollForOlderRef.current');
    expect(scrollSource).toContain('userControllingScroll: isDragSample');
    // 深链 / 搜索定位本身就是明确的历史浏览意图,后续近顶自动补页无需再拖一下。
    const focusEffectStart = source.indexOf('// 深链/搜索:滚到指定消息');
    const focusEffectEnd = source.indexOf('// 新消息红点', focusEffectStart);
    const focusEffectSource = source.slice(focusEffectStart, focusEffectEnd);
    expect(focusEffectSource).toContain('if (!listRevealed) return;');
    expect(focusEffectSource).toContain('userScrollForOlderRef.current = true');
    expect(focusEffectSource).toContain('lastAutoLoadEarlierKeyRef.current = null');
  });

  it('bounds the hidden initial correction while keeping full history mounted', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain('programmaticScrollInFlight: programmaticScrollInFlightRef.current');
    expect(source).toContain('evaluateMobileAnchorVerify({');
    expect(source).toContain('initialAnchorVerifyFrameRef');
    expect(source).toContain('scrollToEndProgrammatically(false)');
    // mVCP 只对 size 常开；流式 resize 仍需记 settle 安静窗，跟随 verifier 不能只依赖
    // readingOlderRef 判断是否等待。
    expect(source).toContain('mvcpSettleAtRef.current = mobileMvcpSettleDeadline(');
    expect(source).toContain('markMobileMvcpSettle();');
    expect(source).toContain('mobileMessageListKeysSignature(itemKeys)');
    expect(source).toContain('[itemKeysSignature, markMobileMvcpSettle]');
    expect(source).not.toContain('[itemKeys, markMobileMvcpSettle]');
    expect(source.match(/isMobileMvcpSettling\(Date\.now\(\), mvcpSettleAtRef\.current\)/g))
      .toHaveLength(2);
    expect(source).toContain('const nextStableFrames = settled ? stableFrames + 1 : 0;');

    expect(source).toContain('key={scrollResetKey}');
    expect(source).not.toContain('tailWindowAnchor');
    expect(source).toContain('previousUserMessageJumpTarget(listDataRef.current, firstVisibleIndexRef.current)');
    expect(source).toContain('firstVisibleIndexRef.current = info.index;');
    expect(source).not.toContain('setFirstVisibleIndex');
    expect(source).toContain('refreshPreviousUserTarget();');
    // 首次校正仍会命令式落底，但 opacity 揭示必须立即交给 UI-thread native driver；
    // 复杂消息占满 JS 时不能把 300ms 隐藏窗拖成长达数秒的白屏。
    expect(source).not.toContain('onLoad={handleListLoad}');
    expect(source).toContain('const [listRevealed, setListRevealed] = useState(false);');
    expect(source).toContain('setListRevealed(true);');
    expect(source).toContain('const initialRevealProgress = useMemo(');
    expect(source).toContain('const initialRevealOpacity = useMemo(');
    expect(source).toContain('<Animated.View style={[styles.messageList, { opacity: initialRevealOpacity }]}>');
    expect(source).toContain('MOBILE_INITIAL_ANCHOR_SETTLE_MS');
    expect(source).toContain('MOBILE_INITIAL_REVEAL_MAX_MS');
    const initialAnchorEffectStart = source.indexOf('// 首次落底：完整历史已经在列表里');
    const initialAnchorEffectEnd = source.indexOf('// 会话切换(scrollResetKey)', initialAnchorEffectStart);
    const initialAnchorEffectSource = source.slice(initialAnchorEffectStart, initialAnchorEffectEnd);
    expect(initialAnchorEffectSource).toContain('Animated.timing(initialRevealProgress, {');
    expect(initialAnchorEffectSource).toContain('useNativeDriver: true');
    expect(initialAnchorEffectSource).toContain('Date.now() >= revealDeadlineAt');
    expect(initialAnchorEffectSource).not.toContain('setTimeout(');
    expect(initialAnchorEffectSource).toContain('scrollToEndProgrammatically(false);');
    expect(initialAnchorEffectSource).toContain('initialAnchorVerifyFrameRef.current = requestAnimationFrame(() => {');
    expect(source).not.toContain('initialRevealTimerRef');
    expect(source).not.toContain('messageListSettling');
  });

  it('resets identity-bound row state before a recycled cell displays another item', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const expandedStateSource = readFileSync(
      resolve(process.cwd(), 'src/session/expandedBlockMemory.ts'),
      'utf8',
    );
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('useRecyclingState<CopyMessageStatus');
    expect(bubbleSource).toContain('useRecyclingState(false)');
    expect(bubbleSource).toContain('useRecyclingState<{');
    expect(bubbleSource).toContain('useRecyclingState<string | null>(null)');
    expect(source).toContain('const [contentWidth, setContentWidth] = useRecyclingState(0);');
    expect(source).toContain('const [resolveState, setResolveState] = useRecyclingState<MediaThumbnailResolveState>');
    expect(source).toContain('const [recycledLocalExpanded, setRecycledLocalExpanded] = useRecyclingState(defaultExpanded);');
    expect(expandedStateSource).toContain('blockId ? store.subscribe(listener) : () => {}');
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
    expect(effectSource).toContain("scrollToEndProgrammatically(true, 'explicit');");
  });

  it('verifies a manual jump-to-latest after issuing the animated scroll', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const callbackStart = source.indexOf('const scrollToBottom = useCallback');
    const callbackEnd = source.indexOf('const jumpToPreviousUserMessage', callbackStart);
    const callbackSource = source.slice(callbackStart, callbackEnd);
    const scrollAt = callbackSource.indexOf("scrollToEndProgrammatically(true, 'explicit');");
    const verifyAt = callbackSource.indexOf('runStickToLatestVerify();');

    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    expect(scrollAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(scrollAt);
    expect(callbackSource).toContain(
      '}, [cancelHistoryPrependTransaction, runStickToLatestVerify, scrollToEndProgrammatically]);',
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
