import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile session main layer desktop-first noise budget', () => {
  it('keeps the empty message state as a short desktop-style status', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const emptyStart = source.indexOf('function EmptyMessages');
    const emptyEnd = source.indexOf('function MessageListActionButton', emptyStart);
    const emptySource = source.slice(emptyStart, emptyEnd);

    expect(emptySource).toContain('message.renderer.emptyMessages');
    expect(emptySource).not.toContain('这台电脑暂无活动消息');
    expect(emptySource).not.toContain('先在桌面端创建或继续一个任务');
    expect(emptySource).not.toContain('emptyText');
  });

  it('shows a syncing placeholder instead of a blank message area during the first sync', () => {
    const rendererSource = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const routeSource = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 首同步期消息区渲染 SyncingMessages(spinner + 「正在同步」,延迟显形防快速路径闪烁),
    // 而不是干净空白——手机消息要走 device-link 往返桌面,空白会被读成"卡住了"。
    const syncingStart = rendererSource.indexOf('function SyncingMessages');
    expect(syncingStart).toBeGreaterThan(-1);
    const syncingEnd = rendererSource.indexOf('function MessageListActionButton', syncingStart);
    const syncingSource = rendererSource.slice(syncingStart, syncingEnd);
    expect(syncingSource).toContain('message.renderer.syncing');
    expect(syncingSource).toContain('ActivityIndicator');
    expect(rendererSource).toContain('SYNCING_PLACEHOLDER_DELAY_MS');
    expect(rendererSource).toContain('ListEmptyComponent={syncingWhileEmpty');
    expect(rendererSource).toContain('<SyncingMessages />');
    expect(routeSource).toContain('syncingWhileEmpty={syncingWhileEmpty}');
  });

  it('keeps the unsynced session state focused on the current action', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const routeStart = source.indexOf('<SessionHeaderBar');
    const routeEnd = source.indexOf('</View>', source.indexOf('<ConnectionBanner', routeStart));
    const routeSource = source.slice(routeStart, routeEnd);
    const syncStart = source.indexOf('function SessionSyncPlaceholder');
    const syncEnd = source.indexOf('function MessageHistoryToggle', syncStart);
    const syncSource = source.slice(syncStart, syncEnd);

    // banner 渲染条件(useShowConnectionBanner):请求级 / transport hold error、可分类连接问题、
    // 目标设备熔断 open(电脑端未响应)立即显示;普通弱网断线经防闪窗口后也显示,不再彻底静默。
    expect(routeSource).toContain('{showConnectionBanner ? (');
    expect(source.replace(/\r\n/g, '\n'))
      .toContain('useShowConnectionBanner(\n    status,\n    connectionRecoveryError,');
    expect(routeSource).not.toContain('connectionError || (loading && !currentSession)');
    expect(syncSource).toContain("t('session.screen.awaitingSync')");
    expect(syncSource).toContain("t('session.screen.resync')");
    expect(syncSource).toContain('RefreshCw');
    expect(syncSource).toContain('sessionSyncRow');
    expect(syncSource).not.toContain('上方同步成功后');
    expect(source).not.toContain('同步成功后可继续发送');
    expect(syncSource).not.toContain('手机端的会话内容显示在这里');
    expect(source).not.toContain('sessionSyncText');
    expect(source).not.toContain('sessionSyncCard');
    expect(source).not.toContain('sessionSyncButtonText');
    expect(source).not.toContain('testID="session.noSessionComposer"');
    expect(source).not.toContain('testID="session.noSessionSyncButton"');
    expect(source).not.toContain('unsyncedComposerButtonText');
  });

  it('does not pin collaboration explanatory copy above the message stream', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const mainStart = source.indexOf('<View style={styles.sessionMainLayer}');
    const mainEnd = source.indexOf('<View style={styles.sessionBottomLayer}', mainStart);
    const mainSource = source.slice(mainStart, mainEnd);

    expect(mainSource).not.toContain('协作会话');
    expect(mainSource).not.toContain('session.collaborationBanner');
    expect(source).not.toContain('sessionCollaborationNotice');
    expect(source).not.toContain('collaborationBanner');
  });

  it('lets Lead sessions compose messages while gating write-orchestration on the write read-only reason', () => {
    // Windows checkout 使用 CRLF；源码契约中的多行 LF 片段必须先统一行尾再比较。
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8')
      .replace(/\r\n/g, '\n');

    // composer 能力(buildSessionOperationLayout)与 header 徽标走 composer-only reason(Lead=可发消息)。
    expect(source).toContain('const composerReadOnlyReason = useMemo(');
    expect(source).toContain('sessionCollaborationComposerReadOnlyReason(currentSession)');
    // 「会话参数未就绪」的两条理由(缓存种入 / 新建在途)**不再**进这个通道:它会把整个
    // 输入框换成只读卡片,而它们只表示还不能 enqueue。composer 保持可用,发送改走 outbox
    // 排队(见 optimisticSessionComposer.test.ts),这两条理由只留给队列行操作。
    expect(source).toContain('      readOnlyReason: composerReadOnlyReason,\n');
    expect(source).toContain('const queueInlineReadOnlyReason = collaborationReadOnlyReason\n    ?? cacheSeededReason\n    ?? pendingCreationReason');
    expect(source).toContain('readOnlyReason={composerReadOnlyReason}');
    // header notice:协作会话(可聊天的 Lead)显示协作标签而非"只读模式"。
    expect(source).toContain('const collaborationLabel = sessionCollaborationLabel(session);');
    expect(source).toContain('if (collaborationLabel) return collaborationLabel;');
    // 写编排(设置/队列/fork-rewind/interaction)仍用写 read-only reason,不被放开。
    expect(source).toContain('readOnlyReason={collaborationReadOnlyReason}');
    expect(source).toContain('onForkMessage={collaborationReadOnlyReason ? undefined : forkAtMessage}');
    expect(source).toContain('onPreviewRewind={collaborationReadOnlyReason ? undefined : previewRewindAtMessage}');
  });

  it('resyncs sessions from connection recovery or target availability, not every presence tick', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('connectionEpoch');
    expect(source).toContain('getPresenceAvailability(deviceId)');
    expect(source).toContain('targetAvailableRef');
    expect(source).toContain('wasAvailable !== true');
    expect(source).not.toContain('lastPresenceSnapshot');
    expect(source).not.toContain('presenceVersion');
  });

  it('drops stale Codex reset alerts after the active session changes during refresh', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const resetStart = source.indexOf('const resetCodexRateLimits');
    const resetEnd = source.indexOf('const loadExtraDirBrowsePath', resetStart);
    const resetSource = source.slice(resetStart, resetEnd);
    const staleOfferStart = resetSource.indexOf('if (!offer');
    const refresh = resetSource.indexOf('await refreshAccountUsage();', staleOfferStart);
    const sessionGuard = resetSource.indexOf(
      'if (contextUsageSessionRef.current !== sessionId) return;',
      refresh,
    );
    const alert = resetSource.indexOf("Alert.alert(t('session.screen.resetReconfirmTitle'), t('session.screen.resetOfferExpired'))", refresh);

    expect(refresh).toBeGreaterThan(-1);
    expect(sessionGuard).toBeGreaterThan(refresh);
    expect(alert).toBeGreaterThan(sessionGuard);
  });

  it('keeps session sheets titled by user-facing desktop concepts only', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 消息队列已从独立弹层退役,inline 到消息流(InlineQueueSection),不再有 sheet 标题。
    expect(source).not.toContain('消息队列');
    expect(source).toContain("t('session.screen.searchTitle')");
    expect(source).not.toContain('REMOTE QUEUE');
    expect(source).not.toContain('MESSAGE SEARCH');
    expect(source).not.toContain('queueSheetEyebrow');
    expect(source).not.toContain('searchSheetEyebrow');
  });

  it('mirrors the complete grouped deletion returned by the desktop host', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const deleteStart = source.indexOf('const deleteMessage = useCallback');
    const deleteEnd = source.indexOf('const confirmRewind', deleteStart);
    const deleteSource = source.slice(deleteStart, deleteEnd);

    expect(deleteSource).toContain("Alert.alert(t('session.screen.deleteMessageTitle')");
    expect(deleteSource).toContain("t('session.screen.deleteMessageBody')");
    expect(deleteSource).toContain('const result = await maker.deleteMessage(sessionId, clientId);');
    expect(deleteSource).toContain('Array.isArray(result.clientIds)');
    expect(deleteSource).toContain('remoteSessionStore.removeMessages(');
    expect(deleteSource).toContain('returnedClientIds.length > 0 ? returnedClientIds : [clientId]');
  });

  it('renders system cards by their desktop title without a generic debug eyebrow', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const desktopSource = readFileSync(resolve(process.cwd(), '../../apps/desktop/src/renderer/components/chat/SystemCard.tsx'), 'utf8');
    const cardStart = source.indexOf('function MobileSystemCard');
    const cardEnd = source.indexOf('function MarkdownBody', cardStart);
    const cardSource = source.slice(cardStart, cardEnd);

    expect(desktopSource).toContain('const titleClass');
    expect(desktopSource).not.toContain('SYSTEM');
    expect(cardSource).toContain('<Text style={styles.systemCardTitle}>{card.title}</Text>');
    expect(cardSource).toContain('function MobileAutoResumeActionRow');
    expect(cardSource).toContain('message.systemCard.autoResume.detail.reason');
    expect(cardSource).toContain('message.systemCard.autoResume.detail.attempt');
    expect(cardSource).toContain('message.systemCard.autoResume.detail.sessionTotal');
    expect(cardSource).toContain('CompactActivityIndicator');
    expect(cardSource).toContain('message.systemCard.autoResume.pendingWithProgress');
    expect(cardSource).toContain('importantForAccessibility="no-hide-descendants"');
    expect(cardSource).toContain('accessible={false}');
    expect(source).toMatch(/autoResumeHeader:\s*\{[\s\S]*?minHeight:\s*44,/);
    expect(cardSource).not.toContain('SYSTEM');
    expect(cardSource).not.toContain('systemCardEyebrow');
    expect(source).not.toContain('systemCardEyebrow: {');
  });
});
