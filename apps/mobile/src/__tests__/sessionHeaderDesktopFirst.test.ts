import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile session header desktop-first surface', () => {
  it('releases the new-session handoff heavy topic when the session screen unmounts', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toMatch(
      /unsubscribe\(`session:\$\{sessionId\}`, deviceId, \['sessions', `session:\$\{sessionId\}`\]\)/,
    );
  });

  it('keeps queue state as an icon attention signal instead of extra mobile-only counters', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).not.toContain('sessionHeaderActionBadge');
    expect(source).not.toContain('sessionHeaderIconBadge');
    expect(source).not.toContain('sessionHeaderIconBadgeText');
    expect(source).not.toContain('badge={');
    expect(source).not.toContain("if (queueCount > 0) return `队列 ${queueCount}`;");
    expect(source).toContain("if (!session) return syncing ? i18n.t('session.screen.syncingSession') : null;\n  if (syncing) return i18n.t('session.screen.syncing');");
    // 后台静默刷新:同步提示由 showSyncingIndicator gate —— 仅首次加载、还没有任何内容时显示,
    // 已有 messages(重开已看过的会话)时后台对账静默,不再弹"正在同步"。
    expect(source).toContain('const showSyncingIndicator = loading && messages.length === 0;');
    expect(source).toContain("if (queuePaused) return i18n.t('session.screen.queuePausedNotice');\n  return null;");
    expect(source).toContain('attention ? (');
  });

  it('keeps the visible header chrome compact while preserving full settings access', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 返回自愈:canGoBack 与真实栈不一致(reload 恢复深路由 / 重复压栈残留)时 GO_BACK
    // 会被静默吞掉,收敛到 useGuardedBack(back 后校验 pathname,没走成 replace 兜底)。
    expect(source).toContain('const goBackToHome = useGuardedBack();');
    expect(source).toContain("import { useGuardedBack } from '@/utils/useGuardedBack';");
    expect(source).toContain('onBack={goBackToHome}');
    expect(source).toContain('<Icon color={color} size={iconSize.action} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('testID="session.controlsToggle"');
    expect(source).toContain('const insets = useSafeAreaInsets();');
    expect(source).toContain('<View style={styles.safeArea} testID="session.screen">');
    expect(source).not.toContain('<SafeAreaView style={styles.safeArea} testID="session.screen">');
    expect(source).not.toContain("import { BlurView } from 'expo-blur';");
    expect(source).toContain("import { BlurBackdrop } from '@/session/BlurBackdrop';");
    expect(source).toContain("function TranslucentBackdrop()");
    expect(source).toContain("<TranslucentBackdrop />");
    expect(source).toContain('return <BlurBackdrop intensity={40} overlayColor={colors.chatHeaderSurface} style={styles.translucentBackdrop} />;');
    expect(source).toContain('<View ref={topOverlayRef} onLayout={handleTopOverlayLayout} pointerEvents="box-none" style={styles.sessionChrome} testID="session.chrome">');
    expect(source).toContain('<View style={[styles.sessionChromeContent, { paddingTop: insets.top }]}>');
    expect(source).toContain("sessionChrome: {\n    left: 0,\n    overflow: 'hidden',\n    position: 'absolute',");
    expect(source).toContain('sessionChromeContent: {');
    expect(source).not.toContain("colors.glassTint");
    expect(source).not.toContain("colors.glassHighlight");
    expect(source).toContain("sessionHeaderBar: {\n    alignItems: 'center',\n    backgroundColor: 'transparent'");
    expect(source).toContain("borderBottomColor: colors.chatHeaderDivider");
    expect(source).toContain('minHeight: 50');
    expect(source).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(source).toContain('<ScreenBackButton');
    expect(source).toContain('testID="session.backButton"');
    expect(source).toContain("sessionHeaderBackButton: {\n    flexShrink: 0,\n  }");
    expect(source).toContain("sessionHeaderIconButton: {\n    alignItems: 'center',\n    borderRadius: radius.pill,\n    height: 38,");
    expect(source).toContain('fontWeight: fontWeight.medium');
    expect(source).not.toContain('size={20} strokeWidth={2}');
    expect(source).not.toContain('minHeight: 54');
  });

  it('switches the leading control to the session-list hamburger on wide-screen navigation', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 宽屏(iPad / 折叠屏展开 / 横屏手机)导航形态:断点判定走 wideSessionNav 纯函数,
    // 左上角三条杠替代返回,抽屉在当前 native Screen 内切任务;窄屏保持 ScreenBackButton。
    expect(source).toContain("import { buildWideSessionNavLayout } from '@/session/wideSessionNav';");
    expect(source).toContain("import { SessionListDrawer } from '@/session/SessionListDrawer';");
    expect(source).toContain('switchDrawerSessionInPlace,');
    expect(source).toContain("from '@/session/sessionDrawerNavigation';");
    // 按平台分闸(发布策略):iOS 只发 iPad,iPhone 横屏也保持返回键;安卓纯宽度闸。
    expect(source).toContain('iosPad: Platform.OS === \'ios\' && Platform.isPad,');
    expect(source).toContain('platform: Platform.OS,');
    expect(source).toContain('onOpenSessionList={wideSessionNav.enabled ? openSessionListDrawer : undefined}');
    expect(source).toContain('icon={Menu}');
    expect(source).toContain('testID="session.sessionListButton"');
    expect(source).toContain('{onOpenSessionList ? (');
    // 抽屉切任务只替换当前 route params：不压栈，也不派发会创建新 route key 的
    // NativeStack REPLACE（后者正是 Android crash / 白屏仍存的生命周期入口）。
    expect(source).toContain('const handleDrawerSelectSession = useCallback((item: RemoteSessionListItem) => {');
    const drawerSelectionStart = source.indexOf('const handleDrawerSelectSession = useCallback');
    const drawerSelectionEnd = source.indexOf('// 前进导航防连点', drawerSelectionStart);
    const drawerSelectionSource = source.slice(drawerSelectionStart, drawerSelectionEnd);
    expect(drawerSelectionSource).toContain('switchDrawerSessionInPlace(navigation, {');
    expect(drawerSelectionSource).not.toContain('router.replace');
    expect(drawerSelectionSource).not.toContain("pathname: '/sessions/[sessionId]'");
    // 三个导航入口都等 drawer overlay 完整卸载；新建 / 回主页可能原生换屏，
    // 切任务虽已改为 replaceParams，也不和 Reanimated 子树退场抢同一帧。
    expect(source).toContain('const pendingDrawerNavigationRef = useRef<(() => void) | null>(null);');
    expect(source).toContain('const sessionListDrawerClosingRef = useRef(false);');
    expect(source).toContain('const [sessionListDrawerOverlayMounted, setSessionListDrawerOverlayMounted] = useState(false);');
    expect(source).toContain('const queueDrawerNavigation = useCallback((action: () => void) => {');
    // 纯关闭(遮罩/back/左滑/当前任务)的 pending 仍为空,必须由独立 closing 闸门
    // 同步锁住约 200ms 退场期;快速二次导航不能登记或改写首次关闭意图。
    expect(source).toContain('if (sessionListDrawerClosingRef.current || pendingDrawerNavigationRef.current) return;');
    expect(source).toContain('sessionListDrawerClosingRef.current = true;\n    pendingDrawerNavigationRef.current = action;');
    expect(source).toContain('const closeSessionListDrawer = useCallback(() => {\n    if (sessionListDrawerClosingRef.current) return;\n    sessionListDrawerClosingRef.current = true;');
    expect(source).toContain('if (targetSession.id === sessionId) {\n      closeSessionListDrawer();');
    expect(source).toContain('onClosed={handleSessionListDrawerClosed}');
    expect(source).toContain('const action = pendingDrawerNavigationRef.current;\n    sessionListDrawerClosingRef.current = false;\n    if (!action) returnDrawerFocusAfterCloseRef.current = true;\n    setSessionListDrawerOverlayMounted(false);');
    expect(source).toContain('pendingDrawerNavigationRef.current = null;\n    action();');
    expect(source).toContain('queueDrawerNavigation(() => {\n      // 必须早于 replaceParams');
    expect(source).toContain('queueDrawerNavigation(() => {\n      guardedPush({');
    expect(source).toContain("queueDrawerNavigation(() => router.dismissTo('/'));");
    // 旋转 / 分屏收窄回窄屏时抽屉必须自动收起(没有入口的悬空 overlay)。
    expect(source).toContain('if (!wideSessionNav.enabled && sessionListDrawerOverlayMounted) closeSessionListDrawer();');
    // Android 退场期(open=false 但 overlay 仍 mounted)必须临时吞掉系统返回;
    // onClosed 解除 mounted 后 effect cleanup 恢复 useGuardedBack 等正常返回链。
    expect(source).toContain("if (Platform.OS !== 'android' || !sessionListDrawerOverlayMounted || sessionListDrawerOpen) return;");
    expect(source).toContain("BackHandler.addEventListener('hardwareBackPress', () => true)");
    expect(source).toContain('}, [sessionListDrawerOpen, sessionListDrawerOverlayMounted]);');
    // 打开抽屉先收键盘(树内 overlay 盖不住键盘)。
    expect(source).toContain('Keyboard.dismiss();\n    setSessionListDrawerOverlayMounted(true);\n    setSessionListDrawerOpen(true);');
    // 读屏模态语义双平台配对:iOS accessibilityElementsHidden + Android importantForAccessibility
    // (accessibilityViewIsModal 只对 iOS 生效,安卓优先发布不能漏 TalkBack);必须覆盖完整退场期。
    expect(source).toContain('accessibilityElementsHidden={sessionListDrawerOverlayMounted}');
    expect(source).toContain("importantForAccessibility={sessionListDrawerOverlayMounted ? 'no-hide-descendants' : 'auto'}");
    // 非导航关闭的焦点归还必须由父级在背景隔离解除后的 commit effect 执行;
    // 导航型关闭及页面已失焦时都不能把焦点抢回旧页面。
    expect(source).toContain('if (sessionListDrawerOverlayMounted || !returnDrawerFocusAfterCloseRef.current) return;');
    expect(source).toContain('if (!navigation.isFocused()) return;');
    expect(source).toContain('AccessibilityInfo.setAccessibilityFocus(returnNode)');
    // 退场期间旋转/折叠/收窄不能直接卸载 Drawer:保留到 onClosed,三类 pending 导航
    // 才都能执行;宽屏 layout 失效后 drawerWidth=0,退场继续用最后有效宽度。
    expect(source).toContain('{wideSessionNav.enabled || sessionListDrawerOverlayMounted ? (');
    expect(source).toContain('if (wideSessionNav.enabled) sessionListDrawerWidthRef.current = wideSessionNav.drawerWidth;');
    expect(source).toContain('width={sessionListDrawerWidthRef.current}');
    // 选任务失败路径:校验先于关闭动画——先关再弹 Alert 会让焦点归还抢走弹窗焦点。
    expect(source).toContain("Alert.alert(t('devices.list.error.sessionDeviceNotFound'));\n      return;\n    }\n    // 不派发 NativeStack REPLACE");
  });

  it('clears the complete composer attachment scope before switching session params', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const boundaryStart = source.indexOf('discardSessionComposerAttachmentStateRef.current = () => {');
    const boundaryEnd = source.indexOf('// 抽屉入口会在 replaceParams 前同步调用', boundaryStart);
    expect(boundaryStart).toBeGreaterThan(-1);
    expect(boundaryEnd).toBeGreaterThan(boundaryStart);
    const boundary = source.slice(boundaryStart, boundaryEnd);

    // 一处完整封口：上传控制器 / 已完成附件 / 预览 / 相册映射 / 未提交选择 / lightbox
    // 与标注本地文件一起退场；排队编辑 stash 也属于旧任务，不能恢复进新任务。
    expect(boundary).toContain('const currentAttachments = [...attachmentsRef.current];');
    expect(boundary).toContain('for (const attachment of currentAttachments)');
    expect(boundary).toContain('for (const attachment of editing?.stashedAttachments ?? [])');
    expect(boundary).toContain('attachmentsRef.current = [];');
    expect(boundary).toContain('setAttachments([]);');
    expect(boundary).toContain('setAttachmentPreviews({});');
    expect(boundary).toContain('setMediaAssetAttachments({});');
    expect(boundary).toContain('setPendingMediaAssets([]);');
    expect(boundary).toContain('setComposerPreviewAttachmentId(null);');
    expect(boundary).toContain('composerAnnotationsRef.current?.forgetAllAttachments();');
    expect(boundary).toContain('discardMobileUploadedAttachment(attachment');
    // 排队编辑保存中的附件不能和 update-content 抢跑回收：界面同步清空，
    // A 的附件快照交给 A cleanup 等保存落定后再判断。
    expect(boundary).toContain('const deferQueueEditAttachments = !!editing && !!queueEditSaveInFlightRef.current;');
    expect(boundary).toContain('queueEditScopeExitAttachmentsRef.current = {');
    expect(boundary).toContain('if (!deferQueueEditAttachments) {');

    // 抽屉动作必须先封住 A 的迟到上传回调，再让 route params 变成 B。
    const drawerSelectionStart = source.indexOf('const handleDrawerSelectSession = useCallback');
    const drawerSelectionEnd = source.indexOf('// 前进导航防连点', drawerSelectionStart);
    const drawerSelection = source.slice(drawerSelectionStart, drawerSelectionEnd);
    const invalidateAt = drawerSelection.indexOf('discardAllPendingUploadsForScopeChange();');
    const discardAt = drawerSelection.indexOf('discardSessionComposerAttachmentStateRef.current();');
    const switchAt = drawerSelection.indexOf('switchDrawerSessionInPlace(navigation, {');
    expect(invalidateAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(invalidateAt);
    expect(switchAt).toBeGreaterThan(discardAt);
    expect(source).toContain('discardAllPendingUploadsForScopeChange();\n    discardSessionComposerAttachmentStateRef.current();');

    // 复用页面实例时输入原生子树也按 sessionId 换代，旧粘贴异步事件没有新任务入口。
    expect(source).toContain('<MobileComposerInputRow\n                    key={sessionId}');
    // key 重挂载前必须在 render 阶段把 composer state 归属切到 B；不能先拿 A 文档
    // 创建 B 的 WebView，再等被动 effect 才纠正。同步缓存缺失时 B 首帧为空态。
    const draftScopeStart = source.indexOf('const activeComposerDraftScopeKey = composerDraftScopeKey(sessionId, routeDraft);');
    const draftScopeEnd = source.indexOf('// chat-text-quote:', draftScopeStart);
    const draftScope = source.slice(draftScopeStart, draftScopeEnd);
    expect(draftScopeStart).toBeGreaterThan(-1);
    expect(draftScopeEnd).toBeGreaterThan(draftScopeStart);
    expect(draftScope).toContain('if (composerDraftStateKey !== activeComposerDraftScopeKey) {');
    expect(draftScope).toContain('const nextScope = readImmediateComposerDraftScope(sessionId, routeDraft);');
    expect(draftScope).toContain('setComposerDocumentState(nextScope.document);');
    expect(draftScope).toContain('setDraft(nextDraft);');
    expect(draftScope).toContain('setComposerDraftHydrated(false);');
    expect(draftScope).toContain('appliedRouteDraftRef.current = null;');
    expect(draftScope).toContain('composerDocumentRef.current = nextScope.document;');
    expect(draftScope).toContain('draftRef.current = nextDraft;');

    const immediateScopeStart = source.indexOf('function readImmediateComposerDraftScope(');
    const immediateScopeEnd = source.indexOf('function composerDraftScopeKey(', immediateScopeStart);
    const immediateScope = source.slice(immediateScopeStart, immediateScopeEnd);
    expect(immediateScope).toContain('readComposerDraftSync(sessionId) ?? routeDraft ??');
    expect(immediateScope).toContain('readComposerDocumentDraftSync(sessionId);');
    expect(immediateScope).toContain('const quotes = getQuotes(sessionId);');
    expect(immediateScope).toContain('resolveOrderedQuoteDraft(sessionId, visibleText, quotes);');

    // render-phase 换代先把旧 promise 的 key 作废，但保留 null 让 B effect 继续读取
    // 仅磁盘草稿；effect 内原有 live-ref 比对继续保证用户新输入不被迟到读取覆盖。
    const hydrationStart = source.indexOf('useEffect(() => {\n    const key = activeComposerDraftScopeKey;');
    const hydrationEnd = source.indexOf('useEffect(() => {\n    if (!composerDraftHydrated', hydrationStart);
    const hydration = source.slice(hydrationStart, hydrationEnd);
    expect(hydration).toContain('const immediateScope = readImmediateComposerDraftScope(sessionId, routeDraft);');
    expect(hydration).toContain('if (cancelled || appliedRouteDraftRef.current !== key) return;');
    expect(hydration).toContain('if (!composerDocumentsEqual(composerDocumentRef.current, immediateDocumentSnapshot)) {');
    const queueCleanupStart = source.indexOf('// 切会话 / 卸载时收尾上一个会话的排队编辑态');
    const queueCleanupEnd = source.indexOf(
      'useEffect(() => {\n    if (canUseRemoteSessionControls)',
      queueCleanupStart,
    );
    const queueCleanup = source.slice(queueCleanupStart, queueCleanupEnd);
    expect(queueCleanup).toContain('attachmentsRef.current = [];\n      setAttachments([]);');
    expect(queueCleanup).not.toContain('setAttachments([...editing.stashedAttachments])');
    expect(queueCleanup).toContain('const scopeExitSnapshot = queueEditScopeExitAttachmentsRef.current;');
    expect(queueCleanup).toContain('const discardQueueEditTransientAttachmentResources =\n        discardQueueEditTransientAttachmentResourcesRef.current;');
    expect(queueCleanup).toContain('discardQueueEditTransientAttachmentResources?.(editing, attachmentsSnapshot);');

    // A 保存落定后的迟到 finalize 只能回收 A 的附件快照，不得触碰复用 controller
    // 或组件级映射；否则 B 在切换后新开的上传会被 A 的 removeAll 一并取消。
    const scopedCleanupStart = source.indexOf('const discardQueueEditTransientAttachmentResources = useCallback');
    const scopedCleanupEnd = source.indexOf('const discardQueueEditTransientAttachments = useCallback', scopedCleanupStart);
    const scopedCleanup = source.slice(scopedCleanupStart, scopedCleanupEnd);
    expect(scopedCleanupStart).toBeGreaterThan(-1);
    expect(scopedCleanupEnd).toBeGreaterThan(scopedCleanupStart);
    expect(scopedCleanup).toContain('remoteSessionStore.getInputProjection(sessionId)');
    expect(scopedCleanup).toContain('discardMobileUploadedAttachment(attachment');
    expect(scopedCleanup).not.toContain('discardAllPendingUploads');
    expect(scopedCleanup).not.toContain('setAttachmentPreviews');
    expect(scopedCleanup).not.toContain('setMediaAssetAttachments');

    // 同任务内放弃 / 切换编辑目标仍需完整清理自己的在途上传与附件映射。
    const localCleanupStart = scopedCleanupEnd;
    const localCleanupEnd = source.indexOf('useEffect(() => {\n    discardQueueEditTransientAttachmentResourcesRef.current', localCleanupStart);
    const localCleanup = source.slice(localCleanupStart, localCleanupEnd);
    expect(localCleanup).toContain('discardAllPendingUploads();');
    expect(localCleanup).toContain('discardQueueEditTransientAttachmentResources(editing, attachmentsAtExit);');
    expect(localCleanup).toContain('setAttachmentPreviews');
    expect(localCleanup).toContain('setMediaAssetAttachments');
  });

  it('keeps pending history access as a lightweight control without message counters', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const start = source.indexOf('function MessageHistoryToggle');
    const end = source.indexOf('function readRouteParam', start);
    const toggleSource = source.slice(start, end);

    expect(toggleSource).toContain("expanded ? t('session.screen.collapseHistory') : t('session.screen.expandHistory')");
    expect(source).toContain('borderRadius: radius.pill');
    expect(toggleSource).not.toContain('messageCount');
    expect(toggleSource).not.toContain('历史消息已展开');
    expect(toggleSource).not.toContain('历史消息已折叠');
    expect(toggleSource).not.toContain('当前先处理上方请求');
    expect(toggleSource).not.toContain('条消息');
  });
});
