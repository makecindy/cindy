import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('任务消息内存治理页面接线', () => {
  const screen = source('app/sessions/[sessionId].tsx');
  const deviceLink = source('src/device-link/DeviceLinkContext.tsx');

  it('只有 focus 与 AppState active 同时成立时 enter，离场立即携 authority 撤权', () => {
    expect(screen).toContain('useFocusEffect(');
    expect(screen).toContain('messageScreenFocusedRef.current = true;');
    expect(screen).toContain("const messageAppActiveRef = useRef(AppState.currentState === 'active');");
    expect(screen).toContain('remoteSessionStore.enterSessionMessageDetail(sessionId)');
    expect(screen).toContain("remoteSessionStore.leaveSessionMessageDetail(sessionId, 'detail-blur', authority)");
    expect(screen).toContain("remoteSessionStore.leaveSessionMessageDetail(sessionId, 'app-background', authority)");
    expect(screen).toContain('setMessageReloadRevision((value) => value + 1);');
    expect(screen).toContain('handledMessageReloadRevisionRef.current === messageReloadRevision');
    expect(screen).toContain('handledMessageReloadRevisionRef.current = messageReloadRevision;');
    expect(screen).toContain('const releasePendingRouteFocusLookup = () => {');
    expect(screen).toContain('releasePendingRouteFocusLookup();');
    expect(screen).toContain('[deviceId, maker, messageReloadRevision, renderItems, routeFocusClientId, routeFocusKey, sessionId]');
  });

  it('首次进入详情在取得 authority 后触发同步，不依赖更早的 mount load', () => {
    const authorityStart = screen.indexOf('const messageAuthorityRef = useRef');
    const authorityEnd = screen.indexOf('const auth = useAuth();', authorityStart);
    const authorityBlock = screen.slice(authorityStart, authorityEnd);
    const firstEnter = authorityBlock.indexOf(
      'messageAuthorityRef.current = remoteSessionStore.enterSessionMessageDetail(sessionId);',
    );
    const firstReload = authorityBlock.indexOf(
      'setMessageReloadRevision((value) => value + 1);',
      firstEnter,
    );
    expect(firstEnter).toBeGreaterThanOrEqual(0);
    expect(firstReload).toBeGreaterThan(firstEnter);
    expect(authorityBlock).not.toContain('shouldReload');
    expect(authorityBlock).not.toContain('lastEnteredMessageSessionRef');
    expect(authorityBlock).toContain('}, [deviceId, sessionId]),');

    const subscriptionStart = screen.indexOf('return startFocusedTopicSubscription({');
    const optimisticOlderStart = screen.indexOf('// 乐观点亮「加载更早」入口', subscriptionStart);
    const subscriptionBlock = screen.slice(subscriptionStart, optimisticOlderStart);
    expect(subscriptionBlock).not.toContain('void load();');
  });

  it('详情读取在请求开始捕获 authority，并在所有消息写入口提交', () => {
    expect(screen).toContain('const messageAuthority = remoteSessionStore.captureSessionMessageAuthority(sessionId);');
    expect(screen).toContain('remoteSessionStore.isSessionMessageAuthorityCurrent(messageAuthority)');
    expect(screen).toContain('remoteSessionStore.setMessages(sessionId, historyPage, { authority: messageAuthority });');
    expect(screen).toContain('authority: messageAuthority,\n            moreBeyondWindow,');
    expect(screen).toContain('{ authority: messageAuthority },\n        );');
    expect(screen).toContain('remoteSessionStore.mergeEarlierMessages(sessionId, pageList, { authority: messageAuthority });');
    expect(screen).toContain('remoteSessionStore.mergeMessages(sessionIdAtStart, rows, { authority: messageAuthority });');
    expect(screen.match(/maker\.listMessages\(/g)).toHaveLength(4);
  });

  it('schedule 关闭翻历史入口，页面工作租约覆盖发送与附件状态', () => {
    expect(screen).toContain('if (isScheduleDetail) return;');
    expect(screen).toContain('hasOlderMessages && !isScheduleDetail');
    expect(screen).toContain('canLoadEarlier={hasOlderMessages && messages.length > 0 && !isScheduleDetail}');
    expect(screen).toContain('remoteSessionStore.acquireSessionMessageWork(sessionId, pageHasMessageWork)');
    expect(screen).toContain('remoteSessionStore.acquireSessionMessageWork(item.sessionId, true)');
    expect(screen).toContain('remoteSessionStore.acquireSessionMessageWork(sessionId, true)');
    expect(screen.match(/messageWorkLease\.release\(\);/g)).toHaveLength(2);
    for (const signal of [
      'outboxItems.length > 0',
      'pendingUploads.length > 0',
      'pastePlaceholderCount > 0',
      'sendInFlightRef.current',
      'sendingQueueClientIds.size > 0',
      'settlingQueueItems.length > 0',
      'attachments.length > 0',
    ]) {
      expect(screen).toContain(signal);
    }
  });

  it('断线补读区分已进入详情与从未打开的 regular，跨代 rewind 不再无条件写正文', () => {
    expect(deviceLink).toContain('remoteSessionStore.hasSessionMessageDetailEntered(sessionId)');
    expect(deviceLink).toContain('? remoteSessionStore.captureSessionMessageAuthority(sessionId)');
    expect(deviceLink).toContain('remoteSessionStore.captureUnenteredSessionMessageAuthority(sessionId)');
    expect(deviceLink).toContain('authority: messageAuthorityAtRequestStart');
    expect(deviceLink).toContain('remoteSessionStore.canCommitUnenteredSessionMessageWindow(\n        unenteredMessageAuthorityAtRequestStart,');
    expect(deviceLink).toContain('remoteSessionStore.setLatestMessageWindow(sessionId, history.value, windowOptions);');
    expect(screen).toContain('remoteSessionStore.invalidateSessionMessageWindow(sessionId, deviceId);');
    expect(screen).not.toContain('remoteSessionStore.setMessages(sessionId, Array.isArray(history.messages)');
  });

  it('缓存 hydrate 同时校验页面 authority 与缓存 key epoch', () => {
    const store = source('src/session/remoteSessionStore.ts');
    expect(store).toContain('const cacheAuthority = captureSessionMessageCacheWriteAuthority(deviceId, sessionId);');
    expect(store).toContain('isSessionMessageCacheWriteAuthorityCurrent(cacheAuthority)');
    expect(store).toContain('remoteSessionStore.isSessionMessageAuthorityCurrent(authority)');
  });

  it('只在任务切换或页面卸载时最终释放媒体队列', () => {
    const queueStart = screen.indexOf('const releaseRemoteMediaQueue = useCallback');
    expect(queueStart).toBeGreaterThanOrEqual(0);
    const queueEnd = screen.indexOf('const backfillRunSeqRef', queueStart);
    const queueBlock = screen.slice(queueStart, queueEnd);
    expect(queueBlock).toContain('remoteMediaQueueRef.current?.releaseAll()');
    expect(queueBlock).toContain('remoteMediaQueueRef.current = null;');
    expect(queueBlock).toContain('[releaseRemoteMediaQueue, sessionId]');
    expect(queueBlock).toContain('releaseRemoteMediaQueue();');
    // 失焦或退后台时组件仍挂载且持有 resolved URL,不能提前 DELETE OSS。
    expect(queueBlock).not.toContain('useFocusEffect(');
    expect(queueBlock).not.toContain("AppState.addEventListener('change'");
  });
});
