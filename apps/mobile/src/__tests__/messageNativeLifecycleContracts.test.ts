import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: JS/native lifecycle contracts for Fabric cell ownership, asynchronous
// MVCP/gesture handoff, native reveal and UITextView selection. Node component
// tests cannot exercise the native commit/measurement or system selection menu.
// Regressions cause blank historical pages, stale recycled media or lost Copy.
// Entry/reopening/tail controller behavior stays in messageEntryPositioning,
// messageReadingRestore and messageTailFollower unit tests. Pure geometry and
// duplicated controller source checks are deliberately not retained here.
describe('native message lifecycle contracts', () => {
it('uses LegendList virtualization with platform-scoped history anchoring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const perfHarness = readFileSync(resolve(process.cwd(), 'app/listperf.tsx'), 'utf8');

    const listStart = source.search(/<LegendList\s/);
    expect(listStart).toBeGreaterThan(-1);
    const listEnd = source.indexOf('      />', listStart);
    expect(listEnd).toBeGreaterThan(listStart);
    const listSource = source.slice(listStart, listEnd);

    // 估高 + 小预渲窗口:挂载集小、mount 帧压进一帧(不可退回大挂载树)。
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
    // offset，中间坐标窗无 cell 而白屏。size 变化始终由 LegendList 锚定；data 变化只在读历史
    // 时锚定——贴底跟随时锚定会把被整批替换的旧可见行钉住，重连补同步时先跳上去再拉回底部。
    expect(listSource).toContain('alignItemsAtEnd');
    expect(listSource).toContain('maintainScrollAtEnd');
    expect(listSource).toContain('maintainVisibleContentPosition={historyPrependNativeMvcpDisabled');
    expect(listSource).toContain('? false');
    expect(listSource).toContain(': { data: anchorVisibleRowsOnDataChange, size: true }}');
    expect(source).toContain(
      'const anchorVisibleRowsOnDataChange = isAwayFromBottom || readingOlderRef.current;',
    );
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
    expect(perfHarness).toContain("const recycle = params.recycle === '1';");
    expect(listSource).toContain('recycleItems={recycleItems}');
    expect(listSource).toContain('getItemType={mobileMessageListItemType}');
    expect(source).toContain('useRecyclingState');
    // 可见性必须由 cell 自己订阅。把可见 key 集合放进 React Context 会在每个
    // onViewableItemsChanged 回调里广播给所有已挂载长消息，快滑时造成整窗重渲染、GC 和白屏。
    // Companion receipts observe visible rows through a ref, without broadcasting cell visibility.
    // Both modes publish visibility, but only companion chats acknowledge read receipts.
    expect(listSource).toContain('onViewableItemsChanged={handleViewableItemsChanged}');
    expect(source).toContain('if (companion) handleCompanionViewableItems(info)');
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
    // Android 的手动锚定等手势结束；iOS 由 native MVCP 保持视口，可在手势中预取。
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
    // Entry/focus ordering is executed in messageEntryPositioning.test.ts:
    // a linked row now positions before reveal, without a preceding tail seek.
    expect(focusEffectSource).toContain('userScrollForOlderRef.current = true');
    expect(focusEffectSource).toContain('lastAutoLoadEarlierKeyRef.current = null');
  });

it('hands the bounded initial reveal to the native animation driver', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
  const start = source.indexOf('// 首次落底：完整历史已经在列表里');
  const end = source.indexOf('// 会话切换(scrollResetKey)', start);
  const reveal = source.slice(start, end);
  expect(reveal).toContain('Animated.timing(initialRevealProgress, {');
  expect(reveal).toContain('useNativeDriver: true');
  expect(reveal).toContain('easing: Easing.step1');
  expect(reveal).not.toContain('setTimeout(');
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
    // 普通列表仍默认使用回收态；只有群聊的普通 ScrollView 注入 React 状态。
    // 同时守住逐层传递，避免嵌套缩略图漏接后恢复原来的群聊崩溃。
    for (const component of ['AttachmentStrip', 'MediaPreview', 'PendingAttachmentImage']) {
      const componentStart = source.indexOf(`function ${component}(`);
      const propsEnd = source.indexOf('}: {', componentStart);
      expect(componentStart).toBeGreaterThan(-1);
      expect(propsEnd).toBeGreaterThan(componentStart);
      expect(source.slice(componentStart, propsEnd)).toContain('usePreviewState = useRecyclingState');
    }
    expect(source).toContain('const [resolveState, setResolveState] = usePreviewState<MediaThumbnailResolveState>');
    expect(source).toContain('const [failedLocalUris, setFailedLocalUris] = usePreviewState<readonly string[]>([]);');
    expect(source.match(/const \[intrinsicSize, setIntrinsicSize\] = usePreviewState</g)).toHaveLength(2);
    expect(source.match(/usePreviewState=\{usePreviewState\}/g)).toHaveLength(2);
    // Rich answers also live outside LegendList. Their ordinary state is safe
    // only behind a message/source identity key; keep the original list contract
    // for every other preview. Regression: PR #6373 used unkeyed React state.
    const richMediaStart = source.indexOf('function RichAnswerMedia(');
    expect(richMediaStart).toBeGreaterThan(-1);
    expect(source.slice(0, richMediaStart)).not.toContain('usePreviewState={useState}');
    const richMediaSource = source.slice(richMediaStart);
    expect(richMediaSource).toContain('const previewKey = JSON.stringify([origin?.deviceId, origin?.sessionId, body.richStateKey ?? body.markdownImageCacheKey, node.id, url]);');
    expect(richMediaSource).toContain('<MediaPreview key={previewKey}');
    expect(richMediaSource).toContain('usePreviewState={useState}');
    const groupSource = readFileSync(
      resolve(process.cwd(), 'src/session/BotGroupMessageAttachments.tsx'), 'utf8',
    );
    expect(groupSource).toContain('usePreviewState={useState}');
    expect(source).toContain('const [recycledLocalExpanded, setRecycledLocalExpanded] = useRecyclingState(defaultExpanded);');
    expect(expandedStateSource).toContain('blockId ? store.subscribe(listener) : () => {}');
  });

it('measures mounted shareable messages for manual sharing sticky selection', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    // Native measurements still drive manual sharing's pinned checkbox, including
    // expanded group children. Screenshot-driven automatic selection was removed.
    const readerStart = source.indexOf('const runStickyShareCheck');
    const readerEnd = source.indexOf('const scheduleStickyShareCheck', readerStart);
    expect(readerStart).toBeGreaterThan(-1);
    expect(readerEnd).toBeGreaterThan(readerStart);
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

it('renders message bodies natively with in-place per-block selectable text', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const flowSource = readFileSync(resolve(process.cwd(), 'e2e/maestro/message_selection.yaml'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);
    const markdownBodyStart = source.indexOf('function MarkdownBody');
    const markdownBodyEnd = source.indexOf('function renderInline', markdownBodyStart);
    const markdownBodySource = source.slice(markdownBodyStart, markdownBodyEnd);

    // 完成态才可选中；伙伴与普通任务的正文和 secondaryBody 都走原生 selectable。
    expect(source).toContain('const canSelectVisibleText = canUseCompletedActions && copyText.trim().length > 0;');
    expect(source).toContain('const bubbleTextSelectable = canSelectVisibleText;');
    expect(bubbleSource).toContain('selectable={bubbleTextSelectable}');
    expect(bubbleSource).toContain('<MarkdownSelectableText selectable={bubbleTextSelectable} style={styles.detailText}>');

    // iOS 部分选择:RN Text 底层是 UILabel 只能整块拷贝(facebook/react-native#13938),
    // 可选中块在 iOS 换用 react-native-uitextview(真 UITextView,系统选择手柄);
    // Android 维持 AppText selectable(本身有手柄)。嵌套 span 必须同为 UITextView 家族。
    expect(source).toContain("from 'react-native-uitextview'");
    expect(source).toContain('function MarkdownSelectableText({');
    expect(source).toContain("if (selectable && allowIosUITextView && Platform.OS === 'ios') {");
    expect(source).toContain('uiTextView');
    expect(source).toContain('function MarkdownSelectableSpan(');
    expect(source).toContain('const SpanText = ctx.SpanText ?? MessageBodyText;');
    expect(markdownBodySource).toContain('blockSelectable && allowIosUITextView && Platform.OS === \'ios\'');

    // 气泡不抢占正文的原生选字或表格、代码块横向滚动手势。
    expect(bubbleSource).not.toContain('<Pressable');
    expect(bubbleSource).not.toContain('onLongPress');
    expect(bubbleSource).not.toContain('<GestureDetector');

    // 列表内正文只有原生渲染路径:无选择 WebView、无全屏选择查看器。
    expect(markdownBodySource).toContain('testID="message.markdownBody"');
    // Agent 回复二次测宽:stretch 量到像素宽后钉死,避免 UITextView 首帧偏矮被列表裁切。
    expect(markdownBodySource).toContain('nextSettledContentWidth');
    expect(markdownBodySource).toContain('collapsable={false}');
    expect(markdownBodySource).toContain('onLayout={handleSettledWidthLayout}');
    expect(markdownBodySource).toContain('pinContentWidth');
    expect(markdownBodySource).toContain('pinSettledWidth');
    expect(markdownBodySource).toContain("pinContentWidth ? { alignSelf: 'stretch' } : null");
    expect(markdownBodySource).toContain(
      'style={pinSettledWidth ? { width: contentWidth, maxWidth: \'100%\' } : null}',
    );
    expect(markdownBodySource).toContain(
      "key={`${group.key}:${pinSettledWidth ? contentWidth : 'hug'}`}",
    );
    expect(markdownBodySource).not.toContain('SelectableMarkdownWebView');
    expect(source).not.toContain('SelectableMarkdownWebView');
    expect(source).not.toContain('MessageTextSelectionModal');
    expect(source).not.toContain('InlineSelectableMessageText');

    // 各块 Text 开原生选中,含内嵌图片 View 的块除外(Android 上 selectable+内嵌 View 有风险)。
    expect(markdownBodySource).toContain('const inlinesSelectable = useCallback((inlines: readonly MobileMarkdownInline[]) => (');
    expect(markdownBodySource).toContain("inline.type === 'image' && imageRendersPreview(inline)");
    expect(markdownBodySource).toContain('isMobileMarkdownImageDirectUrl(inline.url) || managedImagePreviewUrl(inline.url) !== null');
    expect(markdownBodySource).toContain('selectable={inlinesSelectable(block.inlines)}');

    // 跨段选择:连续纯文本块合并进同一个原生文本视图(text_run),原生选择手柄可横跨段落。
    // Android 上长 selectable Text 分块,避免单个超高原生文本视图干扰列表测高/滚动。
    expect(markdownBodySource).toContain('ANDROID_SELECTABLE_TEXT_RUN_GROUPING_OPTIONS');
    expect(markdownBodySource).toContain("...(Platform.OS === 'android' ? ANDROID_SELECTABLE_TEXT_RUN_GROUPING_OPTIONS : {})");
    expect(markdownBodySource).toMatch(/const textRunGroupingOptions = useMemo[(][\s\S]*?imageRendersPreview,/);
    expect(markdownBodySource).not.toContain("selectable === true && Platform.OS === 'android'");
    expect(markdownBodySource).toContain('groupMobileMarkdownSelectableBlocks(blocks, textRunGroupingOptions)');
    expect(markdownBodySource).toContain('testID="message.markdownTextRun"');
    expect(markdownBodySource).toContain("lineHeight: layout.markdownBodyGap");
    expect(markdownBodySource).toContain('!block.textRunContinuation');
    expect(markdownBodySource).toContain('isTextRunContinuationGroup(group)');
    expect(markdownBodySource).toContain('height: layout.markdownBodyGap');
    expect(markdownBodySource).not.toContain('{ gap: layout.markdownBodyGap }');
    expect(source).toContain('mobileMarkdownImageAltChipText(inline.alt)');
    expect(markdownBodySource).toContain('selectable={inlinesSelectable(cell)}');
    expect(markdownBodySource).toContain('selectable={selectable === true}');

    // WebView 独有的用户气泡宽度估算 hack 不复活(原生 Text 自适应宽度)。
    expect(source).not.toContain('estimateSelectableUserBubbleWidth');

    // 列表滚动不被选择态钳制(原生选择手柄由系统处理,与列表滚动无关)。
    expect(source).not.toContain('scrollEnabled={!textSelectionActive}');

    // e2e 流程与新交互对齐:长按正文文字 → 系统选择菜单 → Copy。
    expect(flowSource).toContain('id: "message.markdownBody"');
    expect(flowSource).toContain('visible: "Copy"');
    expect(flowSource).toContain('- tapOn: "Copy"');
    expect(flowSource).not.toContain('message.textSelectionModal');
    expect(flowSource).not.toContain('message.selectableMarkdownBody');
  });
});
