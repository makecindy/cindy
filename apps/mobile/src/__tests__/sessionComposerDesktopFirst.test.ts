import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile session composer desktop-first surface', () => {
  it('fences every active-session snapshot request against newer retry progress', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('const fetchActiveSessionSnapshot = async () => {');
    expect(source).toContain(
      'const activityEpochAtFetchStart = remoteSessionStore.captureActiveSessionSnapshotEpoch();',
    );
    expect((source.match(/fetchActiveSessionSnapshot\(\),/g) ?? []).length).toBe(2);
    expect((source.match(/activeSessionSnapshot\.activityEpochAtFetchStart/g) ?? []).length).toBe(2);
    expect((source.match(/maker\.listActiveSessions\(\)/g) ?? []).length).toBe(1);
  });

  it('uses icon controls for attachment quick actions near the composer', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const voiceStart = source.indexOf('const startVoiceRecording = useCallback(async () => {');
    const voiceEnd = source.indexOf('const removeRemoteFileAttachment = useCallback', voiceStart);
    const voiceSource = source.slice(voiceStart, voiceEnd);
    const finishVoiceStart = source.indexOf('const finishVoiceRecording = useCallback(async (options: { sendAfterTranscribe?: boolean } = {}) => {');
    const finishVoiceEnd = source.indexOf('const cancelVoiceRecording = useCallback', finishVoiceStart);
    const finishVoiceSource = source.slice(finishVoiceStart, finishVoiceEnd);
    const sharedSource = readTextLf(resolve(process.cwd(), 'src/session/MobileComposerInputRow.tsx'), 'utf8');
    const attachmentTraySource = readTextLf(resolve(process.cwd(), 'src/session/ComposerAttachmentTray.tsx'), 'utf8');
    const composerInputStart = source.indexOf('<MobileComposerInputRow');
    const composerInputEnd = source.indexOf('/>', source.indexOf('value={draft}', composerInputStart)) + 2;
    const composerInputSource = source.slice(composerInputStart, composerInputEnd);
    const attachmentButtonStart = source.indexOf('const renderComposerAttachmentButton = () => (');
    const attachmentButtonEnd = source.indexOf('const renderComposerStopButton = () => (', attachmentButtonStart);
    const attachmentButtonSource = source.slice(attachmentButtonStart, attachmentButtonEnd);
    const trailingActionsStart = attachmentButtonEnd;
    const trailingActionsEnd = source.indexOf('const resumeQueue = () => {', trailingActionsStart);
    const trailingActionsSource = source.slice(trailingActionsStart, trailingActionsEnd);
    const voiceButtonStart = source.indexOf('const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (');
    const voiceButtonEnd = source.indexOf('const removeRemoteFileAttachment = useCallback', voiceButtonStart);
    const voiceButtonSource = source.slice(voiceButtonStart, voiceButtonEnd);
    const floatingVoiceIndex = composerInputSource.indexOf('floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}');
    const sendIndex = composerInputSource.indexOf('trailing={composerCardActive ? null : renderComposerTrailingActions()}');
    const composerSurfaceStart = source.indexOf('composerSurface: {');
    // composerOverlayPanel 已随「模型下拉改 ModelPickerSheet 浮窗」删除,锚到下一个样式键。
    const composerSurfaceEnd = source.indexOf('composerSurfaceCompact:', composerSurfaceStart);
    const composerSurfaceStyle = source.slice(composerSurfaceStart, composerSurfaceEnd);
    const sharedStyleStart = sharedSource.indexOf('const makeMobileComposerInputRowStyles');
    const composerInputRowStart = sharedSource.indexOf('row: {', sharedStyleStart);
    const composerInputRowEnd = sharedSource.indexOf('rowMultiline:', composerInputRowStart);
    const composerInputRowStyle = sharedSource.slice(composerInputRowStart, composerInputRowEnd);
    const composerInputRowMultilineStart = sharedSource.indexOf('rowMultiline: {');
    const composerInputRowMultilineEnd = sharedSource.indexOf('rowCompact:', composerInputRowMultilineStart);
    const composerInputRowMultilineStyle = sharedSource.slice(composerInputRowMultilineStart, composerInputRowMultilineEnd);
    const inlineButtonStart = source.indexOf('composerInlineToolButton: {');
    const inlineButtonEnd = source.indexOf('composerToolButtonActive:', inlineButtonStart);
    const inlineButtonStyle = source.slice(inlineButtonStart, inlineButtonEnd);
    const floatingButtonStart = sharedSource.indexOf('voiceButtonAnchor: {', sharedStyleStart);
    const floatingButtonEnd = sharedSource.indexOf('}', floatingButtonStart);
    const floatingButtonStyle = sharedSource.slice(floatingButtonStart, floatingButtonEnd);
    const sendButtonStart = source.indexOf('sendButton: {');
    const sendButtonEnd = source.indexOf('sendButtonInactive:', sendButtonStart);
    const sendButtonStyle = source.slice(sendButtonStart, sendButtonEnd);
    const inputStart = sharedSource.indexOf('input: {', sharedStyleStart);
    const inputEnd = sharedSource.indexOf('voiceButtonAnchor:', inputStart);
    const inputStyle = sharedSource.slice(inputStart, inputEnd);
    const composerStyleStart = source.indexOf('composer: {');
    const composerStyleEnd = source.indexOf('composerScroll:', composerStyleStart);
    const composerStyle = source.slice(composerStyleStart, composerStyleEnd);
    const composerStatusCallIndex = source.indexOf('<ComposerActivityStatus');
    const composerViewStart = source.indexOf('testID="session.composer"');
    const composerScrollEnd = source.indexOf('</ScrollView>', composerViewStart);
    const composerViewSource = source.slice(composerViewStart, composerScrollEnd);
    const voiceStatusIndex = composerViewSource.indexOf('testID="session.voiceStatus"');
    const composerScrollIndex = composerViewSource.indexOf('testID="session.composerScroll"');
    const voiceDraftTextStart = source.indexOf('onTextLayout={handleVoiceDraftTextLayout}');
    const voiceDraftTextEnd = source.indexOf('</Text>', voiceDraftTextStart);
    const voiceDraftTextSource = source.slice(voiceDraftTextStart, voiceDraftTextEnd);
    const voiceMicCaretStart = sharedSource.indexOf('voiceMicCaret: {');
    const voiceMicCaretEnd = sharedSource.indexOf('voiceMicBars:', voiceMicCaretStart);
    const voiceMicCaretStyle = sharedSource.slice(voiceMicCaretStart, voiceMicCaretEnd);
    const voiceDraftOverlayStart = source.indexOf('voiceDraftOverlay: {');
    const voiceDraftOverlayEnd = source.indexOf('voiceDraftOverlayContent:', voiceDraftOverlayStart);
    const voiceDraftOverlayStyle = source.slice(voiceDraftOverlayStart, voiceDraftOverlayEnd);
    const voiceDraftOverlayContentStart = source.indexOf('voiceDraftOverlayContent: {');
    const voiceDraftOverlayContentEnd = source.indexOf('voiceDraftMeasuredBlock:', voiceDraftOverlayContentStart);
    const voiceDraftOverlayContentStyle = source.slice(voiceDraftOverlayContentStart, voiceDraftOverlayContentEnd);
    const voiceDraftMeasuredBlockStart = source.indexOf('voiceDraftMeasuredBlock: {');
    const voiceDraftMeasuredBlockEnd = source.indexOf('voiceDraftCaretOverlay:', voiceDraftMeasuredBlockStart);
    const voiceDraftMeasuredBlockStyle = source.slice(voiceDraftMeasuredBlockStart, voiceDraftMeasuredBlockEnd);
    const voiceDraftCaretOverlayStart = source.indexOf('voiceDraftCaretOverlay: {');
    const voiceDraftCaretOverlayEnd = source.indexOf('voiceDraftText:', voiceDraftCaretOverlayStart);
    const voiceDraftCaretOverlayStyle = source.slice(voiceDraftCaretOverlayStart, voiceDraftCaretOverlayEnd);
    const voiceDraftTextStyleStart = source.indexOf('voiceDraftText: {');
    const voiceDraftTextStyleEnd = source.indexOf('voiceDraftListeningPrompt:', voiceDraftTextStyleStart);
    const voiceDraftTextStyle = source.slice(voiceDraftTextStyleStart, voiceDraftTextStyleEnd);

    expect(source).toContain('PaperPlaneIcon');
    expect(source).toContain('Camera');
    expect(source).toContain('Settings');
    // Context 面板「添加」分组的四个入口 icon(照片 / 截图 / 拍照 / 文件)。
    expect(source).toContain('<Image color={colors.textPrimary}');
    expect(source).toContain('<Camera color={colors.textPrimary}');
    expect(source).toContain('<Scan color={colors.textPrimary}');
    expect(source).toContain('<Folder color={colors.textPrimary}');
    expect(composerInputSource).toContain('cardActive={composerCardActive}');
    expect(composerInputSource).toContain('toolbar={renderComposerToolbar()}');
    expect(source).toContain('const renderComposerToolbar = () => (');
    expect(attachmentButtonSource).toContain('<Plus');
    expect(source).toContain('<Mic color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />');
    expect(composerInputSource).toContain('trailing={composerCardActive ? null : renderComposerTrailingActions()}');
    expect(trailingActionsSource).toContain('<PaperPlaneIcon');
    expect(trailingActionsSource).toContain('color={composerSendDisabled ? colors.textSecondary : colors.ctaText}');
    expect(source).toContain('const composerCardActive = (canUseComposer && composerFocused)');
    expect(source).toContain('|| permissionSheetOpen');
    // 2026-07-29 用户裁决(对齐 Codex):权限入口是 composer 左侧图标钮 + 独立浮窗
    // (MobilePermissionPickerList 由本 screen 直挂 SheetSurface),模型药丸右对齐;
    // 浮窗打开时仍属于 composer 激活态,不能因输入框失焦把底排收起。
    // ModelPickerSheet 的 header 权限入口隐藏(hidePermissionTrigger),不再双入口。
    expect(source).not.toContain('testID="session.composerPermissionButton"');
    expect(source).toContain('testID="session.permissionIndicator"');
    expect(source).toContain('<MobilePermissionPickerList');
    expect(source).toContain('hidePermissionTrigger');
    expect(source).toContain('setPermissionSheetOpen(false)');
    expect(source).toContain('testID="session.composerModelButton"');
    // 模型 + 权限浮窗:ContextSheet 同款独立 Modal(单 Modal 双 SheetSurface 叠层),
    // 不再是 composer 上方的 in-flow drop-up。
    expect(source).toContain('<ModelPickerSheet');
    expect(source).toContain('testID="session.modelSheet"');
    expect(source).not.toContain('composerOverlayPanel');
    expect(source).toContain('onPress={toggleComposerModelPicker}');
    // 选行 fast 写穿只按值变化,不做 fastEditable 门控:切到不支持 fast 的模型时必须把
    // 服务端残留的 fastMode=true 清零(review P1 回归锚)。
    expect(source).toContain('if (next.fastMode !== modelSheetSelection.fastMode)');
    expect(source).not.toContain('fastEditable && next.fastMode');
    // + 号打开可拖动 Context 面板(附件 / 计划模式 / 目标模式收在面板内)。
    expect(source).toContain('testID="session.contextSheet"');
    expect(attachmentButtonSource).toContain('setContextSheetOpen(true)');
    expect(source).toContain("<ContextSheetGroup label={t('session.common.groupMode')}>");
    expect(source).toContain("<ContextSheetGroup label={t('session.common.groupAdd')}>");
    expect(source).not.toContain('testID="session.attachmentPathPanel"');
    expect(source).not.toContain('被控电脑上的文件路径');
    expect(source).toContain('testID="session.composerActivityStatus"');
    expect(source).toContain("t('session.screen.thinking')");
    // 活动状态行的三种说法都要在这里出现。过载退避与传输层重连共用同一个 attempt
    // 字段, 但文案分开: 说「正在重新连接」会把用户引向排查自己的网络
    // (review #844 codex P1)。字符串按 i18n key 断言, 不断言三元表达式的写法。
    expect(source).toContain("'session.screen.networkReconnecting'");
    expect(source).toContain("'session.screen.modelBusyRetrying'");
    expect(source).toContain("'session.screen.rateLimitRetrying'");
    expect(source).toContain('{reconnectAttempt.attempt}/{reconnectAttempt.maxAttempts}');
    expect(source).toContain('ArrowDown');
    expect(source).toContain('useSessionRunStatus');
    expect(source).toContain('remoteSessionRunStatus.tokenUsage');
    expect(source).toContain('remoteSessionRunStatus.startedAt ?? composerActivityStartedAt');
    expect(source).toContain('reconnectAttempt={remoteSessionRunStatus.reconnectAttempt}');
    expect(source).toContain('sideTaskRunning={remoteSessionRunStatus.sideTaskRunning}');
    expect(source).toContain('startedAt={composerActivityStartedAtMs}');
    expect(source).toContain('tokenUsage={composerActivityTokenUsage}');
    expect(source).toContain('{!sideTaskRunning ? (');
    expect(source).toContain('function formatComposerActivityElapsed');
    expect(source).toContain('function formatComposerActivityTokens');
    expect(source).toContain('composerActivityPrimary');
    expect(source).toContain('composerActivityMeta');
    expect(source).toContain('composerActivityMetaText');
    expect(source).toContain('composerActivityFrame');
    expect(source).toContain('marginTop: spacing.lg');
    expect(source).toContain('height: 25');
    expect(source).toContain('composerActivityStatusText');
    expect(source).toContain('composerActivityProgressText');
    expect(composerStatusCallIndex).toBeGreaterThan(-1);
    expect(composerStatusCallIndex).toBeLessThan(composerViewStart);
    expect(composerViewSource).not.toContain('<ComposerActivityStatus');
    expect(source).toContain('composerRuntimePillTextRisky');
    expect(source).toContain('color: colors.statusAccent');
    expect(source).not.toContain("import { BlurView } from 'expo-blur';");
    expect(source).toContain("import { BlurBackdrop } from '@/session/BlurBackdrop';");
    expect(source).toContain("function TranslucentBackdrop()");
    expect(source).toContain("<TranslucentBackdrop />");
    expect(source).toContain('return <BlurBackdrop intensity={40} overlayColor={colors.chatHeaderSurface} style={styles.translucentBackdrop} />;');
    expect(source).toContain("sessionHeaderBar: {\n    alignItems: 'center',\n    backgroundColor: 'transparent'");
    expect(source).toContain('sessionBottomLayer: {\n    backgroundColor: colors.surface');
    expect(source).not.toContain("colors.glassTint");
    expect(source).not.toContain("colors.glassHighlight");
    expect(composerStyle).not.toContain('borderTopColor');
    expect(composerStyle).not.toContain('borderTopWidth');
    expect(composerStyle).toContain('paddingBottom: spacing.xs');
    expect(composerStyle).not.toContain('paddingBottom: spacing.md');
    expect(composerSurfaceStyle).not.toContain('backgroundColor: colors.surfaceElevated');
    expect(composerSurfaceStyle).not.toContain('borderColor: colors.border');
    expect(composerSurfaceStyle).not.toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(composerInputRowStyle).toContain("alignItems: 'stretch'");
    expect(composerInputRowStyle).toContain("flexDirection: 'column'");
    expect(sharedSource).toContain('mainRow: {');
    expect(sharedSource).toContain('cardLayout && toolbar != null');
    expect(composerInputRowStyle).toContain('backgroundColor: colors.chatCodeSurface');
    expect(composerInputRowStyle).toContain('borderColor: colors.sheetActionBorder');
    expect(composerInputRowStyle).toContain('borderRadius: radius.pill');
    expect(composerInputRowStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(composerInputRowStyle).toContain('minHeight: 50');
    expect(composerInputRowStyle).toContain('paddingHorizontal: spacing.md');
    expect(composerInputRowStyle).toContain('paddingVertical: 10');
    expect(composerInputRowStyle).toContain("position: 'relative'");
    expect(sharedSource).toContain("mainRowMultiline: {\n    alignItems: 'flex-end',");
    expect(composerInputRowMultilineStyle).toContain('borderRadius: 30');
    expect(inputStyle).toContain("backgroundColor: 'transparent'");
    expect(inputStyle).toContain('borderWidth: 0');
    expect(inputStyle).not.toContain('borderColor: colors.border');
    expect(inputStyle).not.toContain('borderRadius: radius.pill');
    // 字号 / 行高 / 水平内边距走 composerTextMetrics:WebView 富文本编辑器与语音听写
    // 覆盖层共用同一份度量,三边换行位置必须逐字一致(见 composerVoiceDraftMetrics.test.ts)。
    expect(inputStyle).toContain('...COMPOSER_TEXT_STYLE');
    expect(inputStyle).toContain('maxHeight: MOBILE_COMPOSER_INPUT_MAX_HEIGHT');
    expect(inputStyle).toContain('minHeight: MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT');
    expect(inputStyle).toContain('paddingBottom: COMPOSER_TEXT_PADDING_BOTTOM');
    expect(inputStyle).toContain('paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING');
    expect(inputStyle).toContain('paddingTop: COMPOSER_TEXT_PADDING_TOP');
    expect(inputStyle).toContain("textAlignVertical: 'top'");
    expect(floatingButtonStyle).toContain("bottom: Platform.OS === 'ios' ? 8 : 11");
    // Composer input is a single stable, always-multiline, always-inline instance (no compact↔expanded
    // swap that remounts the native input) so the first tap reliably opens the keyboard — guards the
    // "two taps to focus" regression. Compact rest look kept via minHeight (no fixed height that clips).
    expect(source).not.toContain('multiline={expanded}');
    expect(source).not.toContain('renderComposerTextInput(true)');
    expect(source).not.toContain('renderComposerTextInput(false)');
    expect(source).not.toContain('const renderComposerTextInput = () => (');
    expect(composerInputSource).toContain('<MobileComposerInputRow');
    expect(composerInputSource).toContain('<ComposerRichInput');
    expect(composerInputSource).toContain('document={composerDocument}');
    expect(composerInputSource).toContain('inputElement={(');
    expect(source).toContain("import { DEVICE_LINK_API_BASE_URL, MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';");
    expect(source).toContain("const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualFocusComposer) === '1';");
    expect(source).toContain("const visualOpenSearch = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualOpenSearch) === '1';");
    expect(source).toContain('const visualSearchQuery = MOBILE_VISUAL_MOCK_ENABLED ? readRouteParam(params.visualSearchQuery) : null;');
    expect(source).toContain('if (!visualOpenSearch) return;');
    expect(source).toContain('setSearchOpen(true);');
    expect(source).toContain('if (visualSearchQuery !== null) setSearchQuery(visualSearchQuery);');
    expect(source).toContain('autoFocus={MOBILE_VISUAL_MOCK_ENABLED && visible}');
    expect(composerInputSource).toContain('autoFocus={visualFocusComposer}');
    expect(composerInputSource).toContain('cursorColor={colors.inputCaret}');
    expect(composerInputSource).toContain('selectionColor={colors.inputCaret}');
    expect(sharedSource).toContain("autoFocus?: TextInputProps['autoFocus'];");
    expect(sharedSource).toContain('autoFocus={autoFocus}');
    expect(sharedSource).toContain('multiline = true');
    expect(sharedSource).toContain('multiline={multiline}');
    expect(source).not.toContain('inputCompact: {');
    expect(source).toContain('const COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT = MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT;');
    expect(source).toContain('const COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD = 34;');
    expect(source).toContain('const COMPOSER_INPUT_LINE_HEIGHT = MOBILE_COMPOSER_INPUT_LINE_HEIGHT;');
    expect(source).toContain('const COMPOSER_INPUT_MAX_CONTENT_HEIGHT = MOBILE_COMPOSER_INPUT_MAX_HEIGHT;');
    expect(sharedSource).toContain('export const MOBILE_COMPOSER_INPUT_MAX_VISIBLE_LINES = 12;');
    expect(sharedSource).toContain('export const MOBILE_COMPOSER_INPUT_MAX_HEIGHT = (MOBILE_COMPOSER_INPUT_LINE_HEIGHT * MOBILE_COMPOSER_INPUT_MAX_VISIBLE_LINES)');
    expect(source).toContain('const COMPOSER_VERTICAL_PADDING_HEIGHT = 12;');
    expect(source).toContain('const COMPOSER_STATUS_ROW_RESERVED_HEIGHT = 28;');
    expect(source).toContain('const COMPOSER_STACK_GAP_HEIGHT = 4;');
    expect(source).toContain('const COMPOSER_INPUT_ROW_CHROME_HEIGHT = 22;');
    expect(source).toContain('const COMPOSER_VOICE_CARET_GAP = 2;');
    expect(source).not.toContain('const COMPOSER_VOICE_CARET_RESERVED_WIDTH');
    expect(source).not.toContain('const COMPOSER_VOICE_OVERLAY_HORIZONTAL_PADDING');
    expect(source).toContain('const composerInputIsMultiline = composerResize.dragging');
    expect(source).toContain('const composerEffectiveContentHeight = composerInputContentHeight;');
    expect(source).toContain('const composerInputMaxContentHeight = useMemo(() => {');
    expect(source).toContain('const statusReserve = voiceStatusVisible');
    expect(source).toContain('const availableHeight = nativeShellLayout.composerMaxHeight - composerChromeHeight;');
    expect(source).toContain('Math.max(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT, availableHeight)');
    expect(source).toContain('const composerResize = useComposerResize({');
    expect(source).toContain('const composerInputVisibleHeight = composerResize.visibleContentHeight;');
    expect(source).toContain('const composerInputScrollEnabled = composerResize.scrollEnabled;');
    expect(source).toContain('const composerShellHasScrollableContent = attachments.length > 0');
    expect(source).toContain('const composerScrollEnabled = nativeShellLayout.composerScrollEnabled');
    // 外壳滚动必须仅在真有可滚内容时启用,且 grabber touch-down 通过
    // setNativeProps 同步关闸(绝不能 setState——重页面 re-render 会阻塞
    // JS 线程,拖拽 move 事件被合并延后,位移在 grant 重置前全部丢失)。
    expect(source).toContain('&& composerShellHasScrollableContent;');
    expect(source).not.toContain('&& (!composerInputScrollEnabled || composerShellHasScrollableContent);');
    expect(source).toContain('const handleGrabberTouchActiveChange = useCallback((active: boolean) => {');
    expect(source).toContain('composerScrollViewRef.current?.setNativeProps({');
    expect(source).toContain('onGrabberTouchActiveChange: handleGrabberTouchActiveChange,');
    expect(source).toContain('ref={composerScrollViewRef}');
    expect(source).not.toContain('const composerScrollEnabled = nativeShellLayout.composerScrollEnabled || voiceIsListening || composerInputScrollEnabled;');
    expect(source).toContain('onContentSizeChange={handleComposerInputContentSizeChange}');
    expect(source).not.toContain('voiceIsListening && { height: composerInputVisibleHeight }');
    expect(source).not.toContain('const voiceDraftOverlayWidth = Math.max(0, composerTextInputFrameWidth);');
    expect(source).not.toContain('const voiceDraftBlockWidth = Math.max(');
    expect(source).not.toContain('const voiceDraftTextWidth = Math.max(0, voiceDraftBlockWidth - COMPOSER_VOICE_CARET_RESERVED_WIDTH);');
    expect(source).toContain('scrollEnabled={composerInputScrollEnabled}');
    expect(source.match(/scrollEnabled={composerInputScrollEnabled}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(composerInputSource).toContain('maxHeight={composerResize.inputMaxHeight}');
    expect(composerInputSource).toContain('inputFrameHeight={composerResize.frameHeight}');
    expect(composerInputSource).toContain('resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}');
    expect(sharedSource).toContain('{ maxHeight },');
    expect(source).not.toContain('{ height: composerInputVisibleHeight');
    expect(composerInputSource).toContain('multilineShape={!composerCardActive && composerInputIsMultiline}');
    expect(source).toContain("position: 'absolute'");
    expect(source).toContain('bottom: 0');
    expect(source).toContain('safeAreaBottomInset: insets.bottom');
    expect(source).toContain('const bottomOverlayHeight = useMemo(');
    expect(source).toContain('nativeShellLayout.keyboardBottomInset');
    expect(source).toContain('onLayout={handleBottomOverlayLayout}');
    expect(source).toContain('bottomOverlayHeight={bottomOverlayHeight}');
    expect(source).toContain('styles.sessionBottomLayer,');
    expect(source).toContain('testID="session.bottomLayer"');
    expect(source).toContain('testID="session.bottomContent"');
    expect(source).toContain("paddingBottom: sessionOperationLayout.composerSlot === 'pending-interaction'");
    expect(source).toContain('? 0\n                  : insets.bottom');
    expect(source.match(/safeAreaBottomInset={insets\.bottom}/g)).toHaveLength(2);
    expect(source).toContain('pointerEvents="box-none"\n            style={[');
    expect(source).toContain('nativeShellLayout.wideViewport && { maxWidth: nativeShellLayout.contentMaxWidth }');
    expect(source).toContain('sessionBottomContent: {');
    expect(source).toContain('modelSummary: [modelLabel, effortLabel].filter(Boolean).join');
    expect(source).toContain('const COMPOSER_CONTROL_HIT_SLOP = { bottom: 8, left: 8, right: 8, top: 8 };');
    expect(source.match(/hitSlop={COMPOSER_CONTROL_HIT_SLOP}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('const composerHasText = draft.trim().length > 0;');
    expect(source).toContain('const composerQuoteCount = composerDocumentQuotes(composerDocument).length;');
    expect(source).toContain('const composerHasPayload = composerHasText || attachments.length > 0 || pendingUploads.length > 0 || composerQuoteCount > 0;');
    expect(source).toContain('const composerShowSendButton = composerLayout.send.visible || voiceStartPending;');
    expect(source).not.toContain('composerLayout.send.visible && (!voiceIsListening || composerHasPayload)');
    expect(source).toContain('const latestDocument = latestDraft.trim()');
    expect(source).toContain('reconcileComposerProjectedText(documentBeforeStop, latestDraft)');
    expect(source).toContain('if (options.sendAfterTranscribe && (composerDocumentHasContent(latestDocument) || attachments.length > 0))');
    expect(source).toContain('const currentTurnStreaming = useMemo(');
    expect(source).toContain('const canStopCurrentRun = (remoteSessionRunning || currentTurnStreaming)');
    expect(source).toContain('const canStopComposer = canStopQueue || canStopCurrentRun;');
    expect(source).toContain('canStop: canUseComposer && canStopComposer,');
    expect(source).not.toContain('canStop: canUseComposer && canStopQueue,');
    expect(source).toContain('const voiceUiAvailable = shouldShowMobileVoiceUi(Platform.OS);');
    expect(source).toContain('const composerVoicePlacement = voiceUiAvailable');
    expect(source).toContain('hasTrailingAction: composerSendSlotIsStop || composerShowSendButton');
    expect(source).toContain('const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (');
    // 录音状态由语音按钮形态表达（Mic / 红点计时胶囊 / spinner），状态行只承载错误。
    expect(source).toContain('const voiceStatusVisible = voiceUiAvailable && Boolean(voiceError);');
    expect(voiceButtonSource).toContain(') : voiceRecordingTimer.label !== null ? (');
    expect(voiceButtonSource).toContain('<VoiceRecordingPillContent');
    // 录音中语音按钮展开成红点+计时胶囊,右缘锚定、只向左生长;旧的红框 Square 形态不再使用。
    expect(voiceButtonSource).not.toContain('<Square');
    expect(voiceStatusIndex).toBeGreaterThan(-1);
    expect(composerScrollIndex).toBeGreaterThan(-1);
    expect(voiceStatusIndex).toBeLessThan(composerScrollIndex);
    expect(source).toContain('testID="session.voiceMicCaret"');
    expect(sharedSource).toContain('export function VoiceMicWaveCaret');
    expect(source).toContain('const composerInputRef = useRef<ComposerRichInputHandle | null>(null);');
    expect(source).toContain('const voiceDraftScrollRef = useRef<ScrollView>(null);');
    expect(composerInputSource).toContain('ref={composerInputRef}');
    expect(composerInputSource).not.toContain('inputRef={composerInputRef}');
    expect(sharedSource).toContain('ref={inputRef as never}');
    expect(source).toContain('ref={voiceDraftScrollRef}');
    expect(source).toContain('contentContainerStyle={styles.voiceDraftOverlayContent}');
    // 听写期间禁止碰隐藏编辑器的 caret(2026-07-28):setSelectionToEnd 底层是
    // focusEditor,WebView 程序化 focus + keyboardDisplayRequiresUserAction=false
    // 会在点语音的同时弹出软键盘。听写文字由覆盖层渲染,caret 只在用户点输入框
    // (停止听写并有意打字)时由 WebKit 按触点放置。
    expect(source).not.toContain('setSelectionToEnd');
    expect(source).toContain('voiceDraftScrollRef.current?.scrollToEnd({ animated: false });');
    expect(source).toContain('caretHidden={voiceIsListening}');
    expect(source).toContain('const handleComposerInputPressIn = useCallback(() => {');
    expect(source).toContain('onPressIn={handleComposerInputPressIn}');
    expect(source).toContain("placeholder={voiceIsListening ? '' : composerLayout.input.placeholder}");
    expect(source).toContain('placeholderTextColor={colors.textTertiary}');
    expect(source).toContain('inputStyle={voiceIsListening ? styles.inputVoiceHidden : undefined}');
    expect(source).toContain('styles.voiceDraftOverlay');
    expect(voiceDraftOverlayStyle).toContain('...StyleSheet.absoluteFill');
    expect(voiceDraftOverlayStyle).toContain("overflow: 'hidden'");
    expect(voiceDraftOverlayContentStyle).not.toContain('minHeight: COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT');
    expect(voiceDraftOverlayContentStyle).not.toContain("alignItems: 'flex-start'");
    expect(voiceDraftOverlayContentStyle).toContain('paddingBottom: COMPOSER_TEXT_PADDING_BOTTOM');
    expect(voiceDraftOverlayContentStyle).toContain('paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING');
    expect(voiceDraftOverlayContentStyle).toContain('paddingTop: COMPOSER_TEXT_PADDING_TOP');
    expect(voiceDraftOverlayContentStyle).not.toContain("width: '100%'");
    expect(voiceDraftMeasuredBlockStyle).not.toContain("alignSelf: 'flex-start'");
    expect(voiceDraftMeasuredBlockStyle).toContain('minHeight: COMPOSER_INPUT_LINE_HEIGHT');
    expect(voiceDraftMeasuredBlockStyle).not.toContain('paddingRight: COMPOSER_VOICE_CARET_RESERVED_WIDTH');
    expect(voiceDraftMeasuredBlockStyle).toContain("position: 'relative'");
    expect(voiceDraftMeasuredBlockStyle).not.toContain("width: '100%'");
    expect(voiceDraftCaretOverlayStyle).toContain("position: 'absolute'");
    expect(voiceDraftTextStyle).not.toContain("alignSelf: 'flex-start'");
    expect(voiceDraftTextStyle).toContain('color: colors.textPrimary');
    expect(voiceDraftTextStyle).not.toContain("color: 'transparent'");
    expect(voiceDraftTextStyle).not.toContain('flexShrink: 1');
    expect(voiceDraftTextStyle).not.toContain("flexWrap: 'wrap'");
    expect(voiceDraftTextStyle).not.toContain("maxWidth: '100%'");
    expect(voiceDraftTextStyle).not.toContain('minWidth: 0');
    expect(voiceDraftTextStyle).not.toContain("width: '100%'");
    expect(source).not.toContain('inputVoiceListening: {');
    expect(source).not.toContain('paddingRight: COMPOSER_VOICE_CARET_RESERVED_WIDTH');
    expect(voiceMicCaretStyle).toContain('height: MOBILE_COMPOSER_INPUT_LINE_HEIGHT');
    expect(voiceMicCaretStyle).toContain("justifyContent: 'center'");
    expect(source.match(/voiceDraftScrollRef\.current\?\.scrollToEnd\(\{ animated: false \}\);/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(source).toContain('const [voiceDraftCaretFrame, setVoiceDraftCaretFrame] = useState({ left: 0, top: 0 });');
    expect(source).not.toContain('const [composerTextInputFrameWidth, setComposerTextInputFrameWidth] = useState(0);');
    expect(source).not.toContain('const [voiceDraftContentHeight, setVoiceDraftContentHeight] = useState(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT);');
    expect(source).not.toContain('const handleComposerTextInputFrameLayout = useCallback((event: LayoutChangeEvent) => {');
    expect(source).not.toContain('onLayout={handleComposerTextInputFrameLayout}');
    expect(source).toContain('const handleVoiceDraftTextLayout = useCallback((event: TextLayoutEvent) => {');
    expect(source).toContain('const lastLine = lines[lines.length - 1];');
    expect(source).toContain('lastLine.x + lastLine.width + COMPOSER_VOICE_CARET_GAP');
    expect(source).not.toContain('voiceDraftBlockWidth - COMPOSER_VOICE_CARET_WIDTH - COMPOSER_VOICE_CARET_EDGE_INSET');
    expect(source).toContain('lastLine.y + ((lastLine.height - COMPOSER_INPUT_LINE_HEIGHT) / 2)');
    expect(source).not.toContain('setVoiceDraftContentHeight((currentHeight) => (');
    expect(source).toContain('const voiceDraftShowsListeningPrompt = voiceIsListening && draft.length === 0;');
    expect(source).toContain('styles.voiceDraftListeningPrompt');
    expect(source).toContain('<Text style={styles.voiceDraftListeningText}>{composerLayout.input.placeholder}</Text>');
    expect(source).not.toContain('voiceDraftOverlayWidth > 0 && {');
    expect(source).not.toContain('maxWidth: voiceDraftOverlayWidth');
    expect(source).not.toContain('minWidth: voiceDraftOverlayWidth');
    expect(source).not.toContain('width: voiceDraftOverlayWidth');
    expect(source).not.toContain('voiceDraftBlockWidth > 0 && {');
    expect(source).not.toContain('maxWidth: voiceDraftBlockWidth');
    expect(source).not.toContain('minWidth: voiceDraftBlockWidth');
    expect(source).not.toContain('width: voiceDraftBlockWidth');
    expect(source).not.toContain('voiceDraftTextWidth > 0 && {');
    expect(source).not.toContain('maxWidth: voiceDraftTextWidth');
    expect(source).not.toContain('minWidth: voiceDraftTextWidth');
    expect(source).not.toContain('width: voiceDraftTextWidth');
    expect(source).not.toContain('lineBreakStrategyIOS="standard"');
    expect(source).not.toContain('textBreakStrategy="simple"');
    expect(source).not.toContain('android_hyphenationFrequency="none"');
    expect(source).toContain('onTextLayout={handleVoiceDraftTextLayout}');
    expect(voiceDraftTextSource).toContain('{draft}');
    expect(source).toContain('styles.voiceDraftCaretOverlay');
    expect(source).toContain('left: voiceDraftCaretFrame.left');
    expect(source).toContain('top: voiceDraftCaretFrame.top');
    expect(source).not.toContain('voiceMicCaretInline');
    expect(source).not.toContain('<VoiceMicWaveCaret color={colors.statusReady} inline />');
    // 语音态占位文案就是普通态 TextInput 的 placeholder,必须与 placeholderTextColor 同源,
    // 否则一进语音态这行字会变色(2026-07-31 用户定案:不再用 statusReady 蓝绿)。
    expect(source).toContain('placeholderTextColor={colors.textTertiary}');
    expect(source).toContain('voiceDraftListeningText: {\n    color: colors.textTertiary,');
    expect(source).not.toContain('voiceDraftListeningText: {\n    color: colors.statusReady,');
    expect(source).toContain('finishVoiceRecordingRef.current?.();');
    expect(source).toContain('const voiceStopInFlightRef = useRef(false);');
    expect(voiceSource).toContain('|| voiceStopInFlightRef.current');
    expect(finishVoiceSource).toContain('if (voiceStopInFlightRef.current) return;');
    expect(finishVoiceSource).toContain('const controller = voiceControllerSessionRef.current;');
    expect(finishVoiceSource).toContain('if (!controller) return;');
    expect(finishVoiceSource).toContain('voiceStopInFlightRef.current = true;');
    expect(finishVoiceSource.indexOf('voiceControllerSessionRef.current = null;')).toBeLessThan(
      finishVoiceSource.indexOf('const latestDraft = await controller.stop();'),
    );
    expect(finishVoiceSource).toContain('voiceStopInFlightRef.current = false;');
    expect(composerInputSource).toContain('floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}');
    expect(composerInputSource).not.toContain('floatingVoiceButtonStyle=');
    expect(composerInputSource).toContain('voicePlacement={composerVoicePlacement}');
    expect(sharedSource).toContain('voicePlacement?.inline || voicePlacement?.floating');
    expect(sharedSource).toContain('styles.voiceButtonAnchor,');
    expect(sharedSource).toContain('voicePlacement.floating && styles.voiceButtonAnchorWithTrailing,');
    expect(sharedSource).toContain('cardLayout && styles.voiceButtonAnchorCard,');
    // 录音中语音按钮以「红色停止方块」可见,禁止任何 opacity:0 隐藏样式回归
    // (旧 gestureAnchor 设计曾把听写中的按钮隐藏,会让停止录音无可见控件)。
    expect(source).not.toContain('composerInlineToolButtonGestureAnchor');
    // 语音锚点只剩两档(12 / 52):停止任务在语音左边后,第三档(92)已删除。
    // 若回归三档,录音期间首段转写落地会让语音按钮整格横跳,原位正好变成停止任务。
    expect(source).not.toContain('composerFloatingVoiceButtonWithInlineStop');
    expect(source).not.toContain('composerFloatingVoiceButtonStyle');
    // 槽位顺序不变量(对齐桌面 2026-07-25 定案):停止任务 → 语音占位 → 发送槽。
    const toolbarStart = source.indexOf('const renderComposerToolbar = () => (');
    const toolbarEnd = source.indexOf('const renderComposerInputOverlay', toolbarStart);
    const toolbarSource = source.slice(toolbarStart, toolbarEnd);
    const toolbarInlineStopIndex = toolbarSource.indexOf('{renderComposerInlineStop()}');
    const toolbarVoiceSlotIndex = toolbarSource.indexOf('<ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />');
    const toolbarSendSlotIndex = toolbarSource.indexOf('{renderComposerSendSlot()}');
    expect(toolbarInlineStopIndex).toBeGreaterThan(-1);
    expect(toolbarVoiceSlotIndex).toBeGreaterThan(toolbarInlineStopIndex);
    expect(toolbarSendSlotIndex).toBeGreaterThan(toolbarVoiceSlotIndex);
    const trailingFragmentStart = source.indexOf('const renderComposerTrailingActions = () => (');
    const trailingFragmentEnd = source.indexOf('const resumeQueue = () => {', trailingFragmentStart);
    const trailingFragmentSource = source.slice(trailingFragmentStart, trailingFragmentEnd);
    const trailingInlineStopIndex = trailingFragmentSource.indexOf('{renderComposerInlineStop()}');
    const trailingVoiceSlotIndex = trailingFragmentSource.indexOf('<ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />');
    const trailingSendSlotIndex = trailingFragmentSource.indexOf('{renderComposerSendSlot()}');
    expect(trailingInlineStopIndex).toBeGreaterThan(-1);
    expect(trailingVoiceSlotIndex).toBeGreaterThan(trailingInlineStopIndex);
    expect(trailingSendSlotIndex).toBeGreaterThan(trailingVoiceSlotIndex);
    expect(voiceButtonSource).toContain('buttonStyle');
    expect(floatingVoiceIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(floatingVoiceIndex).toBeLessThan(sendIndex);
    expect(inlineButtonStyle).toContain('height: 34');
    expect(inlineButtonStyle).toContain('width: 34');
    expect(inlineButtonStyle).not.toContain('height: 36');
    expect(inlineButtonStyle).not.toContain('width: 36');
    expect(inlineButtonStyle).not.toContain('height: 42');
    expect(inlineButtonStyle).not.toContain('width: 42');
    expect(floatingButtonStyle).toContain("position: 'absolute'");
    expect(floatingButtonStyle).toContain('right: MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT');
    expect(floatingButtonStyle).toContain("bottom: Platform.OS === 'ios' ? 8 : 11");
    expect(floatingButtonStyle).toContain('zIndex: 2');
    expect(sharedSource).toContain('right: spacing.md + MOBILE_COMPOSER_CONTROL_SIZE + MOBILE_COMPOSER_TOOL_GAP');
    expect(sendButtonStyle).toContain('height: 34');
    expect(sendButtonStyle).toContain('width: 34');
    expect(sendButtonStyle).not.toContain('height: 36');
    expect(sendButtonStyle).not.toContain('width: 36');
    expect(sendButtonStyle).not.toContain('height: 42');
    expect(sendButtonStyle).not.toContain('width: 42');
    expect(composerInputSource).not.toContain('size={19}');
    expect(source).toContain('const composerSendSlotIsStop');
    expect(source).toContain('messageListFollowLatestRequestKey');
    expect(source).toContain('requestMessageListFollowLatest();');
    expect(source).toContain('documentOverride?: ComposerDocument;');
    expect(source).toContain('const documentBeforeStop = composerDocumentRef.current;');
    expect(source).toContain('await sendLatest({ documentOverride: latestDocument });');
    expect(source).toContain('sendLatestRef.current = send;');
    expect(source).toContain('if (options.documentOverride) applyComposerDocument(options.documentOverride);');
    expect(source).toContain('flushComposerDraftWrites,');
    expect(source).toContain('readComposerDocumentDraft,');
    expect(source).toContain('readComposerDocumentDraftSync,');
    expect(source).toContain('saveComposerDocumentDraft,');
    expect(source).toContain('saveComposerDocumentDraft(sessionId, value);');
    expect(source).toContain('saveComposerDraft(sessionId, projected);');
    expect(source).toContain('void flushComposerDraftWrites(sessionId);');
    expect(source).toContain('readComposerDraftSync(sessionId)');
    expect(source).toContain('const immediateDocumentSnapshot = immediateDocument;');
    expect(source).toContain('const quoteHydration = immediateQuotes.length > 0');
    expect(source).toContain(': hydrateQuotes(sessionId);');
    expect(source).toContain('quoteHydration,');
    expect(source).toContain('!composerDocumentsEqual(composerDocumentRef.current, immediateDocumentSnapshot)');
    expect(source).toContain('if (canUseComposer) return;');
    expect(source).toContain('setModelSheetOpen(false);');
    expect(source).toContain('if (!canUseComposer || !currentSession || !modelSheetSelection) return;');
    expect(source).toContain('modelSheetOpen && canUseComposer');
    expect(source).toContain('disabled={controlBusy || !canUseComposer}');
    expect(source).toContain('createMobileCindyVoiceCredential');
    // Voice startup claims the pressIn-prewarmed ASR connection when one is
    // fresh (credential already resolved, WebSocket already connecting) and
    // falls back to building the managed credential itself otherwise. 手机语音
    // 只保留 Cindy 官方托管路径:BYOK/穿透已删除。
    expect(source).toContain('const [prewarmedVoice, localVoiceInputHistory] = await Promise.all([');
    expect(source).toContain('takePrewarmedMobileVoiceAsr(deviceId) ?? Promise.resolve(null),');
    expect(source).not.toContain('MobileVoiceServiceMode');
    expect(source).not.toContain('LiteLlm');
    expect(source).toContain('?? createMobileCindyVoiceCredential(deviceId);');
    expect(source).toContain('onPressIn={handleVoiceButtonPressIn}');
    expect(source).toContain(`prewarmMobileVoiceStart(deviceId, {
      getAccessToken: () => auth.getAccessToken(),
      refreshAccessToken: () => auth.refreshAccessToken(),
      apiFetch: auth.apiFetch,
    });`);
    expect(source).toContain('connectionProvider: (providerId: string) => voiceContext.createAsrConnection(providerId),');
    expect(source).toContain('voiceContext.createRefinerTarget(providerId, options),');
    expect(source).toContain('voiceContext.warmRefiner(input),');
    expect(source).toContain('getMobileVoiceInputHistoryForHost(deviceId),');
    // Device link is opened non-blocking (not awaited): dictation goes through the
    // cloud ASR proxy and does not need the link, so it must not gate mic start.
    expect(source).toContain('void openLink(deviceId).catch(() => undefined);');
    expect(source).not.toContain('openLink(deviceId).then(() => undefined),');
    // No start cue on mobile: playing a cue via expo-audio during capture stalls
    // the AVAudioEngine record tap (see mobileVoiceCue.ts). Only the end cue is wired.
    expect(source).not.toContain('playMobileVoiceInputStartCue');
    expect(source).not.toContain('onReadyForStartCue');
    expect(source).toContain('onReadyForEndCue: credential.settings?.playInteractionSound ? playMobileVoiceInputEndCue : undefined,');
    expect(source).toContain('const startController = async () => {');
    expect(source).toContain('await startController();');
    // openLink is fired before the credential/history read (which precedes controller.start()).
    expect(voiceSource.indexOf('void openLink(deviceId).catch(() => undefined);')).toBeLessThan(
      voiceSource.indexOf('await controller.start();'),
    );
    expect(source).not.toContain('openLink(deviceId),\n        startController(),');
    expect(source).not.toContain('syncVoiceCredential');
    expect(source).not.toContain('allowStoredFallback: !forceRefresh');
    expect(source).toContain('getMobileVoiceInputHistoryForHost');
    expect(source).toContain('recordMobileVoiceInputHistoryForHost');
    expect(source).toContain('localVoiceInputHistory,');
    expect(source).toContain('recordHistory: (text) => recordMobileVoiceInputHistoryForHost(deviceId, text)');
    expect(source).toContain('updateHistoryEntry: (entryId, text) => updateMobileVoiceInputHistoryEntryForHost(deviceId, entryId, text)');
    expect(source).not.toContain('styles.sendButtonStop');
    expect(source).not.toContain('sendButtonStop:');
    expect(source).toContain('fill={composerLayout.stop.disabled ? colors.textSecondary : colors.ctaText}');
    expect(source).toContain('color={composerLayout.stop.disabled ? colors.textSecondary : colors.ctaText}');
    expect(source).toContain('pressedStyle={styles.sendButtonPressed}');
    expect(source).toContain('pressedStyle === undefined ? styles.routeButtonPressed : pressedStyle');
    expect(source).not.toContain('composerShowStatusRow');
    expect(source).not.toContain('composerStatusRow');
    expect(source).not.toContain('composerStatusText');
    expect(source).not.toContain('testID="session.composerStatus"');
    expect(source).not.toContain('composerLayout.statusText');
    expect(composerInputSource).not.toContain('<Folder');
    expect(source).not.toContain('styles.attachmentAddText');
    // 附件托盘(图片缩略图卡 + 文本 chip 的 X 移除按钮)收敛到共用组件 ComposerAttachmentTray。
    expect(source).toContain('<ComposerAttachmentTray');
    expect(attachmentTraySource).toContain('<X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />');
    expect(source).not.toContain('attachmentRemoveText');
    expect(source).not.toContain('<Text style={styles.attachmentRemoveText}>×</Text>');
    expect(source).not.toContain('attachmentToggleText');
    expect(source).not.toContain('composerGuidanceCard');
    expect(source).not.toContain('composerGuidanceText');
    expect(source).not.toContain('composerToolButtons');
    expect(source).not.toContain('composerToolRow');
    expect(source).not.toContain('composerStopIconButton');
    expect(source).not.toContain('composerToolText');
    expect(source).not.toContain('sendButtonText');
    expect(source).not.toContain('stopButtonText');
    expect(source).not.toContain('stopButtonPressed');
    expect(source).not.toContain('voiceButtonText');
    expect(source).not.toContain('voiceCancelText');
    expect(source).not.toContain('<Square color={colors.surface} size={14} strokeWidth={2} />');
    expect(source).not.toContain('<Text style={styles.voiceCancelText}>取消</Text>');
    expect(source).not.toContain('<Text style={styles.voiceCancelText}>设置</Text>');
  });

  it('projects mobile voice feedback into the composer draft with the recording timer pill', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const sharedSource = readTextLf(resolve(process.cwd(), 'src/session/MobileComposerInputRow.tsx'), 'utf8');
    const voiceStart = source.indexOf('const startVoiceRecording = useCallback(async () => {');
    const voiceEnd = source.indexOf('const removeRemoteFileAttachment = useCallback', voiceStart);
    const voiceSource = source.slice(voiceStart, voiceEnd);
    const composerInputStart = source.indexOf('<MobileComposerInputRow');
    const composerInputEnd = source.indexOf('/>', source.indexOf('value={draft}', composerInputStart)) + 2;
    const composerInputSource = source.slice(composerInputStart, composerInputEnd);

    expect(voiceSource).toContain('readCurrentDraft: () => draftRef.current');
    expect(source).toContain('const voiceStartupInFlightRef = useRef(false);');
    expect(source).toContain('const voicePermissionRequestInFlightRef = useRef(false);');
    expect(source).toContain('const voiceStopInFlightRef = useRef(false);');
    expect(voiceSource).toContain('|| voiceStopInFlightRef.current');
    expect(voiceSource).toContain('resolveMobileVoiceRecordingPermission({');
    expect(voiceSource).toContain('voiceStartupInFlightRef.current = true;');
    expect(voiceSource.indexOf('resolveMobileVoiceRecordingPermission({')).toBeLessThan(
      voiceSource.indexOf('voiceStartupInFlightRef.current = true;'),
    );
    expect(voiceSource).toContain('getPermission: getRecordingPermissionsAsync');
    expect(voiceSource).toContain("isAppActive: () => AppState.currentState === 'active'");
    expect(voiceSource).toContain(
      "voicePermissionRequestSeqRef.current !== permissionRequestSeq\n"
      + "        || AppState.currentState !== 'active'\n"
      + "      ) return;\n"
      + "      startupSeq = voiceStartupSeqRef.current + 1;",
    );
    expect(voiceSource).toContain('voiceStartupInFlightRef.current = false;');
    expect(voiceSource).toContain('onDraftChanged: setComposerDraft');
    expect(voiceSource).toContain('isMobileRealtimeAudioAvailable()');
    expect(voiceSource.indexOf('isMobileRealtimeAudioAvailable()')).toBeLessThan(
      voiceSource.indexOf('resolveMobileVoiceRecordingPermission({'),
    );
    expect(voiceSource).toContain('mobileVoiceRealtimeAudioUnavailableError()');
    expect(voiceSource).toContain('const documentBeforeStop = composerDocumentRef.current;');
    expect(voiceSource).toContain('const latestDraft = await controller.stop();');
    expect(voiceSource).toContain('await sendLatest({ documentOverride: latestDocument });');
    expect(composerInputSource).toContain('inputTestID="session.composerInput"');
    expect(sharedSource).toContain('testID={inputTestID}');
    expect(composerInputSource).toContain('value={draft}');
    expect(composerInputSource).toContain('onChangeText={setComposerDraft}');
    expect(source).toContain('testID="session.voiceStatus"');
    expect(source).not.toContain('mobileVoiceStateLabel(voiceState)');
    expect(source).toContain('const canOpenVoiceSettings = isMobileVoiceMicPermissionError(voiceError);');
    // 录音计时胶囊(红点 + m:ss,2026-07-25 用户定案对齐桌面)走共享 VoiceRecordingPill;
    // 计时/宽度状态集中在 useMobileVoiceRecordingTimer,页面不得再自造 duration 状态。
    expect(source).toContain("import { VoiceRecordingPillContent, useMobileVoiceRecordingTimer } from '@/session/VoiceRecordingPill';");
    // 计时输入含 pressIn 乐观 pending(按下即录的即时反馈,对齐桌面 activeRecording)。
    // expanded 含乐观 pending(按下即展开),counting 只认真实采集——启动链路
    // (权限弹窗等)不计入录音时长(review P1)。
    expect(source).toContain('expanded: voiceIsListening || voiceStartPending,');
    expect(source).toContain('counting: voiceIsListening,');
    expect(source).toContain('const voiceStartedOnPressInRef = useRef(false);');
    // pending 世代守卫:切会话后旧启动收尾不得塌掉新录音的乐观胶囊(review P1)。
    expect(source).toContain('if (voiceStartPendingSeqRef.current === pendingSeq) setVoiceStartPending(false);');
    // 手势被系统/滚动打断时撤销按下即录(review P1)。
    expect(source).toContain('cancelVoiceForAppBackground();');
    expect(source).toContain('testID="session.voiceRecordingPill"');
    expect(source).toContain('{ width: voiceRecordingTimer.pillWidth }');
    expect(source).not.toContain('voiceDuration');
    expect(source).not.toContain('recordingDuration');
    expect(source).not.toContain('formatVoiceDuration');
    expect(source).not.toContain('durationMs');
  });
});
