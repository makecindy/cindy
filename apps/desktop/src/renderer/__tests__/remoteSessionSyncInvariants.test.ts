/**
 * remoteSessionSyncInvariants.test.ts —— device-link 健壮化关键接线的源不变式。
 * 锁住:重 topic 随 WS 重连重建 + 多触发源对账 + banner 接线,防回退成"订一次就不管"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const syncSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useRemoteSessionSync.ts'),
  'utf8',
);
const sessionViewSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);
const sessionHeaderSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'SessionContentHeader.tsx'),
  'utf8',
);
const sidebarUpperSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);
const sessionItemSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionItem.tsx'),
  'utf8',
);
const sessionCardSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionCard.tsx'),
  'utf8',
);
const projectNodeSrc = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectNode.tsx'),
  'utf8',
);
const makerChatStoreSrc = readFileSync(
  resolve(__dirname, '..', 'lib', 'makerChatStore.ts'),
  'utf8',
);
const makerTransportSrc = readFileSync(
  resolve(__dirname, '..', 'lib', 'makerTransport.ts'),
  'utf8',
);
const chatInputSrc = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('useRemoteSessionSync 接线不变式', () => {
  it('WS 重连(onStatusChanged online)重建重 topic 订阅 + 对账', () => {
    expect(syncSrc).toContain('onStatusChanged');
    expect(syncSrc).toContain("p.status !== 'online'");
    expect(syncSrc).toContain('subscribeHeavy()');
    expect(syncSrc).toContain('reconcileRemoteMessages');
  });
  it('多触发源:presence 回在线 / turn 结束(isRunning) / 窗口聚焦 / 手动 resync', () => {
    expect(syncSrc).toContain('onPresenceChanged');
    expect(syncSrc).toContain('agentStatus.isRunning');
    expect(syncSrc).toContain("addEventListener('focus'");
    expect(syncSrc).toContain('refreshRemoteDeviceSessions');
  });
  it('编排逻辑抽进注入式纯核 createRemoteSessionSyncEngine,hook 仅作 adapter', () => {
    expect(syncSrc).toContain('export function createRemoteSessionSyncEngine');
    expect(syncSrc).toContain('createRemoteSessionSyncEngine(');
    expect(syncSrc).toContain('engine.subscribeHeavy()');
    expect(syncSrc).toContain('engine.primeRunning(');
    expect(syncSrc).toContain('engine.dispose()');
  });
});

describe('CCAgentSessionView 接线不变式', () => {
  it('用 useRemoteSessionSync(替代 mount-once 重 topic effect)+ 渲染连接 banner', () => {
    expect(sessionViewSrc).toContain('useRemoteSessionSync(sessionId, remoteDeviceId)');
    expect(sessionViewSrc).toContain('useRemoteSessionConnection(remoteDeviceId)');
    expect(sessionViewSrc).toContain('<RemoteSessionBanner');
    // 旧的 mount-once 重 topic effect 已被 hook 取代(不再就地订阅 session: topic)。
    expect(sessionViewSrc).not.toContain('const topic = `session:${sessionId}`');
  });
  it('断线缓存的远程 session 可打开查看并继续乐观发送', () => {
    expect(sessionViewSrc).toContain(
      "const remoteSessionUnavailable = remoteConn === 'reconnecting' || remoteConn === 'host-offline'",
    );
    expect(sessionViewSrc).not.toContain('if (remoteSessionUnavailable) return false');
    expect(sessionViewSrc).not.toContain('remoteSessionUnavailableRef');
    expect(sessionViewSrc).toContain('if (!remoteDeviceId) {');
    expect(sessionViewSrc).not.toContain('beforeEnqueue: checkVendorReady');
    // device-link 远程交接期间仍要禁用(见 remoteHandoffPreparing):那几段 await
    // 可能数十秒,不禁用的话用户补发的消息会插到草稿提交的首条之前。
    expect(sessionViewSrc).toContain(
      "disabled={remoteHandoffPreparing || session?.source === 'review'}",
    );
  });
  it('补选目录后的续发保持 delivery mode，并按本地/远端策略清理原 composer', () => {
    expect(sessionViewSrc).toContain('deliveryMode: MessageDeliveryMode;');
    expect(sessionViewSrc).toContain(
      "const dispatch = pending.deliveryMode === 'steer' ? steerMessage : sendMessage;",
    );
    expect(sessionViewSrc).toContain('if (accepted) {');
    expect(sessionViewSrc).toContain('pending.onDeferredAccepted?.();');
    expect(sessionViewSrc).toContain('dispatchDeferredUiAssignment(sessionId, undefined).catch');
    expect(sessionViewSrc).toContain(
      '...(opts?.onDeferredAccepted ? { onDeferredAccepted: opts.onDeferredAccepted } : {})',
    );
    expect(chatInputSrc).toContain('onDeferredAccepted,');
    expect(chatInputSrc).toMatch(
      /if \(optimisticallyClearRemoteComposer\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n){2}\s*optimisticComposerRestored = false;\s*clearSentComposer\(\{ preserveNewerContent: true \}\);\s*\} else \{[\s\S]*?clearSentComposer\(\);\s*\}/,
    );
  });
  it('已有远程 session 断线时跳过来源门禁，远程草稿与本地任务仍保留门禁', () => {
    expect(chatInputSrc).toContain(
      'const enforceConnectedSourceGate = !sessionId || !deviceLinkDeviceId;',
    );
    expect(chatInputSrc).toMatch(
      /const noConnectedSource =\s*enforceConnectedSourceGate &&\s*!!currentModelAgentKind/,
    );
    expect(chatInputSrc).toMatch(
      /if\s*\(\s*enforceConnectedSourceGate\s*&&\s*currentModelAgentKind\s*&&[\s\S]*?\)\s*\{/,
    );
  });
  it('断线缓存的远程 session 可查看,但生命周期/元数据写操作必须走统一 gate', () => {
    expect(sessionHeaderSrc).toContain(
      'remoteSessionUnavailable || isRemoteSessionWriteBlocked(session)',
    );
    expect(sidebarUpperSrc).toContain('isRemoteSessionWriteBlocked(session)');
    expect(sidebarUpperSrc).toContain('selectedSessions.some(isRemoteSessionWriteBlocked)');
    expect(sessionItemSrc).toContain(
      'const remoteWritesBlocked = isRemoteSessionWriteBlocked(session)',
    );
    expect(sessionCardSrc).toContain(
      'const remoteWritesBlocked = isRemoteSessionWriteBlocked(session)',
    );
    expect(sessionViewSrc).toContain('remoteSessionUnavailable={remoteSessionUnavailable}');
  });
  it('断线 device-link session 不能触发 Stop 或新窗口写入口', () => {
    expect(sessionViewSrc).toContain('const handleStopSession = useCallback');
    expect(sessionViewSrc).toContain('if (remoteSessionUnavailable)');
    expect(sessionViewSrc).toContain('onStop={handleStopSession}');
    expect(sessionHeaderSrc).toMatch(
      /<DropdownMenuItem[\s\S]*?disabled=\{remoteWritesBlocked\}[\s\S]*?onSelect=\{handleOpenInNewWindow\}[\s\S]*?openInNewWindow/,
    );
    expect(sessionItemSrc).toMatch(
      /<DropdownMenuItem[\s\S]*?disabled=\{remoteWritesBlocked\}[\s\S]*?onSelect=\{handleOpenInNewWindowSelect\}[\s\S]*?openInNewWindow/,
    );
    expect(sessionCardSrc).toMatch(
      /<DropdownMenuItem[\s\S]*?disabled=\{remoteWritesBlocked\}[\s\S]*?onSelect=\{handleOpenInNewWindowSelect\}[\s\S]*?openInNewWindow/,
    );
  });
  it('live / 历史错误横幅都携带 SSH 与 device-link 执行端归属', () => {
    expect(sessionViewSrc).toMatch(
      /<ErrorTailErrorBanner[\s\S]*?remoteHostId=\{session\?\.remoteHostId \?\? undefined\}[\s\S]*?deviceLinkDeviceId=\{remoteDeviceId\}/,
    );
    expect(sessionViewSrc).toMatch(
      /<ErrorBanner[\s\S]*?remoteHostId=\{session\?\.remoteHostId \?\? undefined\}[\s\S]*?deviceLinkDeviceId=\{remoteDeviceId\}/,
    );
  });
  it('远程活动镜像在 turn 执行或等待交互时压过中断时间戳启发式', () => {
    expect(sessionViewSrc).toContain('useRemoteSessionActivity(sessionId');
    expect(sessionViewSrc).toContain('agentStatus.isRunning || remoteTurnActive');
    expect(sessionViewSrc).toContain('sessionInterruptAcked || remoteTurnActive');
  });
  it('断线 device-link project 不能从项目标题 + 入口创建远程 draft', () => {
    expect(projectNodeSrc).toContain(
      'const projectWritesBlocked = isDeviceLinkWriteBlocked(project)',
    );
    expect(projectNodeSrc).toContain('disabled={projectWritesBlocked}');
    expect(projectNodeSrc).toContain('handleCreateInProject');
    expect(projectNodeSrc).toContain('handleArchiveAll');
    expect(sidebarUpperSrc).toContain('isDeviceLinkWriteBlocked(project)');
  });
});

describe('弱网 optimistic mutation 粘滞路由不变式', () => {
  it('发送相关的控制操作在 mirror clear 后仍使用 pinned device', () => {
    expect(makerChatStoreSrc).toContain(
      'const remoteDeviceId = getStickySessionDeviceId(sessionId);',
    );
    expect(makerChatStoreSrc).toContain(
      'const steerApi = remoteDeviceId ? makerApiForDevice(remoteDeviceId) : makerApiFor(sessionId);',
    );
    expect(makerChatStoreSrc).toContain(
      'const operation = beginInputProjectionOperation(sessionId, remoteDeviceId);',
    );
    expect(makerChatStoreSrc).toContain(
      'const triggerApi = remoteDeviceId ? makerApiForDevice(remoteDeviceId) : makerApiFor(sessionId);',
    );
    expect(makerChatStoreSrc).toMatch(/clearOperation\.api\s*\.closeSession/);
    expect(makerChatStoreSrc).toContain(
      'const remoteDeviceId = sourceRemoteDeviceId ?? getStickySessionDeviceId(sessionId);',
    );
  });

  it('自动标题和会话元数据读取使用 sticky 远端判定', () => {
    expect(makerChatStoreSrc).toContain('if (getStickySessionDeviceId(sessionId)) {');
    expect(makerTransportSrc).toContain(
      '// Session metadata is part of the same remote send attempt as the later',
    );
  });
});
