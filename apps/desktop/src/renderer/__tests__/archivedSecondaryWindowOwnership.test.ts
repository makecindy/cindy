import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);
const orcaSplitViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaSplitView.tsx'),
  'utf8',
);
const workdirBrowseRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseRoute.tsx'),
  'utf8',
);
const dirtyPreflightSource = readFileSync(
  resolve(
    __dirname,
    '..',
    'features',
    'cc-agent',
    'workdir-browse',
    'hooks',
    'useConfirmSwitchAwayIfDirty.ts',
  ),
  'utf8',
);
const makerChatStoreSource = readFileSync(
  resolve(__dirname, '..', 'lib', 'makerChatStore.ts'),
  'utf8',
);
const registerSource = readFileSync(
  resolve(__dirname, '..', '..', 'main', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n/g, '\n');
const makerSendTransactionSource = readFileSync(
  resolve(__dirname, '..', '..', 'main', 'maker-ipc', 'makerSendTransaction.ts'),
  'utf8',
);

describe('archived secondary-window ownership', () => {
  it('removes embedded split panes without letting them close the route-owning window', () => {
    const archivedEffect = sessionViewSource.indexOf("if (session?.status !== 'archived') return;");
    const ownerGate = sessionViewSource.indexOf('if (!ownsWindowRoute) {', archivedEffect);
    const removePane = sessionViewSource.indexOf(
      'splitGroupStore.removeSession(sessionId);',
      ownerGate,
    );
    const ownerGateEnd = sessionViewSource.indexOf('\n    }', ownerGate);
    const closePreflight = sessionViewSource.indexOf(
      'await onBeforeSecondaryWindowClose()',
      ownerGateEnd,
    );
    const cancelGate = sessionViewSource.indexOf(
      'if (!allowClose || cancelled) return;',
      closePreflight,
    );
    const closeWindow = sessionViewSource.indexOf(
      'window.electronAPI?.windowCloseSelf();',
      cancelGate,
    );

    expect(archivedEffect).toBeGreaterThan(-1);
    expect(ownerGate).toBeGreaterThan(archivedEffect);
    expect(removePane).toBeGreaterThan(ownerGate);
    expect(removePane).toBeLessThan(ownerGateEnd);
    expect(ownerGateEnd).toBeGreaterThan(ownerGate);
    expect(closePreflight).toBeGreaterThan(ownerGateEnd);
    expect(cancelGate).toBeGreaterThan(closePreflight);
    expect(closeWindow).toBeGreaterThan(cancelGate);
    expect(sessionViewSource).toMatch(
      /\}, \[\s*session\?\.status,\s*sessionId,\s*ownsWindowRoute,\s*onBeforeSecondaryWindowClose,\s*confirmCloseActiveFileIfDirty,\s*secondaryWindowArchiveOwner,\s*\]\);/,
    );
  });

  it('marks the Orca lead as route owner and the worker as embedded', () => {
    const leadView = orcaSplitViewSource.indexOf('sessionIdProp={leadSessionId}');
    const leadOwner = orcaSplitViewSource.indexOf('navigationMode="route-owner"', leadView);
    const workerView = orcaSplitViewSource.indexOf('sessionIdProp={workerSession.id}', leadOwner);
    const workerEmbedded = orcaSplitViewSource.indexOf(
      'navigationMode="sidebar-embedded"',
      workerView,
    );

    expect(leadView).toBeGreaterThan(-1);
    expect(leadOwner).toBeGreaterThan(leadView);
    expect(workerView).toBeGreaterThan(leadOwner);
    expect(workerEmbedded).toBeGreaterThan(workerView);
    expect(orcaSplitViewSource).toContain(
      'onBeforeSecondaryWindowClose={onBeforeSecondaryWindowClose}',
    );
    expect(orcaSplitViewSource).toContain('secondaryWindowArchiveOwner="host"');
  });

  it('keeps the Orca host subscribed to archived leads and closes after the dirty-file preflight', () => {
    expect(orcaSplitViewSource).toContain("useCCSessions({ includeArchived: 'all' })");
    const archivedLeadGuard = orcaSplitViewSource.indexOf(
      "if (leadSession?.status !== 'archived') return;",
    );
    const secondaryWindowGuard = orcaSplitViewSource.indexOf(
      'if (!isSecondaryWindow()) return;',
      archivedLeadGuard,
    );
    const closePreflight = orcaSplitViewSource.indexOf(
      'await onBeforeSecondaryWindowClose()',
      secondaryWindowGuard,
    );
    const cancelGate = orcaSplitViewSource.indexOf(
      'if (!allowClose || cancelled) return;',
      closePreflight,
    );
    const closeWindow = orcaSplitViewSource.indexOf(
      'window.electronAPI?.windowCloseSelf();',
      cancelGate,
    );

    expect(archivedLeadGuard).toBeGreaterThan(-1);
    expect(secondaryWindowGuard).toBeGreaterThan(archivedLeadGuard);
    expect(closePreflight).toBeGreaterThan(secondaryWindowGuard);
    expect(cancelGate).toBeGreaterThan(closePreflight);
    expect(closeWindow).toBeGreaterThan(cancelGate);
  });

  it('lets the workdir route protect dirty files before either route-owning chat closes', () => {
    expect(workdirBrowseRouteSource).toContain('() => confirmSwitchAway(selectedPath, null)');
    expect(
      workdirBrowseRouteSource.match(
        /onBeforeSecondaryWindowClose=\{confirmSecondaryWindowClose\}/g,
      ),
    ).toHaveLength(2);
  });

  it('uses the active editor dirty-file preflight when an ordinary task route closes', () => {
    expect(sessionViewSource).toContain(': await confirmCloseActiveFileIfDirty();');
    expect(dirtyPreflightSource).toContain('export function useConfirmCloseActiveFileIfDirty()');
    expect(dirtyPreflightSource).toContain('const handle = getActiveFileBodyHandle();');
    expect(dirtyPreflightSource).toContain('if (!handle || !handle.isDirty()) return true;');
    expect(dirtyPreflightSource).toContain("if (choice === 'cancel') return false;");
    expect(dirtyPreflightSource).toContain('return await handle.save();');
  });

  it('uses a synchronous archive guard plus enqueue-time fences for every send path', () => {
    const guardDeclaration = sessionViewSource.indexOf(
      'const blocksArchivedSecondaryWindowInput =',
    );
    const refDeclaration = sessionViewSource.indexOf(
      'const archivedSecondaryWindowInputBlockedRef = useRef(',
      guardDeclaration,
    );
    const pushFence = sessionViewSource.indexOf(
      'archivedSecondaryWindowInputBlockedRef.current = {',
      refDeclaration + 1,
    );
    const handleSend = sessionViewSource.indexOf('const handleSend = useCallback(', pushFence);
    const initialSendGuard = sessionViewSource.indexOf(
      'if (isArchivedSecondaryWindowInputBlocked()) return false;',
      handleSend,
    );
    const steerDispatch = sessionViewSource.indexOf(
      'const accepted = await steerMessage(',
      initialSendGuard,
    );
    const steerGuard = sessionViewSource.lastIndexOf(
      'if (isArchivedSecondaryWindowInputBlocked()) return false;',
      steerDispatch,
    );
    const sendDispatch = sessionViewSource.indexOf(
      'const accepted = await sendMessage(',
      steerDispatch,
    );
    const sendGuard = sessionViewSource.lastIndexOf(
      'if (isArchivedSecondaryWindowInputBlocked()) return false;',
      sendDispatch,
    );
    const composerDisabled = sessionViewSource.indexOf('disabled={', sendDispatch);
    const composerGuard = sessionViewSource.indexOf(
      'blocksArchivedSecondaryWindowInput',
      composerDisabled,
    );

    expect(guardDeclaration).toBeGreaterThan(-1);
    expect(refDeclaration).toBeGreaterThan(guardDeclaration);
    expect(pushFence).toBeGreaterThan(refDeclaration);
    expect(initialSendGuard).toBeGreaterThan(handleSend);
    expect(steerGuard).toBeGreaterThan(initialSendGuard);
    expect(steerDispatch).toBeGreaterThan(steerGuard);
    expect(sendGuard).toBeGreaterThan(steerDispatch);
    expect(sendDispatch).toBeGreaterThan(sendGuard);
    expect(composerDisabled).toBeGreaterThan(sendDispatch);
    expect(composerGuard).toBeGreaterThan(composerDisabled);

    const workingDirChange = sessionViewSource.slice(
      sessionViewSource.indexOf('const handleWorkingDirChange = useCallback('),
      sessionViewSource.indexOf('const maybeShowContextUsage = useCallback('),
    );
    const recoverableFirstMessage = sessionViewSource.slice(
      sessionViewSource.indexOf('const restoreRecoverableHandoff = useCallback('),
      sessionViewSource.indexOf('const pendingGoalConsumedRef = useRef(false);'),
    );
    const ordinarySend = sessionViewSource.slice(
      sessionViewSource.indexOf('const handleSend = useCallback('),
      sessionViewSource.indexOf('const handleStopSession = useCallback('),
    );

    for (const source of [workingDirChange, recoverableFirstMessage, ordinarySend]) {
      expect(source).toContain('beforeEnqueue: allowArchivedSecondaryWindowEnqueue');
      expect(source).toContain('beforeDispatch: allowArchivedSecondaryWindowEnqueue');
    }
  });

  it('rechecks the archive lifecycle after slash reconciliation and before every desktop side effect', () => {
    const slashDispatch = sessionViewSource.slice(
      sessionViewSource.indexOf('const maybeDispatchDesktopSlashCommand = useCallback('),
      sessionViewSource.indexOf('const handleWorkingDirChange = useCallback('),
    );
    const reconciliation = slashDispatch.indexOf('const reconciled =');
    const lifecycleFence = slashDispatch.indexOf('await options.beforeDesktopDispatch()');
    const startReview = slashDispatch.indexOf('await window.electronAPI.maker.startReview({');
    const executeDesktopCommand = slashDispatch.indexOf(
      'const dispatchResult = await dispatchCommand(hit',
    );

    expect(reconciliation).toBeGreaterThan(-1);
    expect(lifecycleFence).toBeGreaterThan(reconciliation);
    expect(startReview).toBeGreaterThan(lifecycleFence);
    expect(executeDesktopCommand).toBeGreaterThan(startReview);
    expect(slashDispatch).toContain("if (dispatchResult === 'rejected')");
    expect(slashDispatch).toContain('requireActiveSession: true');

    for (const source of [
      sessionViewSource.slice(
        sessionViewSource.indexOf('const handleWorkingDirChange = useCallback('),
        sessionViewSource.indexOf('const maybeShowContextUsage = useCallback('),
      ),
      sessionViewSource.slice(
        sessionViewSource.indexOf('const handleSend = useCallback('),
        sessionViewSource.indexOf('const handleStopSession = useCallback('),
      ),
      sessionViewSource.slice(
        sessionViewSource.indexOf('const restoreRecoverableHandoff = useCallback('),
        sessionViewSource.indexOf('const pendingGoalConsumedRef = useRef(false);'),
      ),
    ]) {
      expect(source).toContain('beforeDesktopDispatch: allowArchivedSecondaryWindowEnqueue');
    }
  });

  it('serializes secondary-window desktop commands, Review, and clear against archival in Main', () => {
    const desktopHandler = registerSource.slice(
      registerSource.indexOf('MAKER_INVOKE.EXECUTE_DESKTOP_COMMAND'),
      registerSource.indexOf('MAKER_INVOKE.LIST_AGENT_COMMANDS'),
    );
    const reviewRegistration = registerSource.slice(
      registerSource.indexOf('registerReviewStartHandler(makerSessionRegistry'),
      registerSource.indexOf(
        'registerPrecreatedWorktreeDiscardHandler',
        registerSource.indexOf('registerReviewStartHandler(makerSessionRegistry'),
      ),
    );
    const clearHandler = registerSource.slice(
      registerSource.indexOf('MAKER_INVOKE.INPUT_CLEAR_SESSION'),
      registerSource.indexOf('MAKER_INVOKE.ABORT_SESSION'),
    );

    expect(desktopHandler).toContain('assertTrustedAppRendererEvent(e)');
    expect(desktopHandler).toContain('isSecondarySessionWindowEvent(e)');
    expect(desktopHandler).toContain('const mustFenceActiveSession =');
    expect(desktopHandler).toContain('await withSendToSessionLock(sessionId, async () => {');
    expect(desktopHandler).toContain('await assertSessionActiveForManualDispatch(sessionId)');
    expect(desktopHandler).toContain('sessionRouteLockHeld: true');
    expect(desktopHandler).toContain('rawContext.requireActiveSession === true');
    expect(reviewRegistration).toContain('acquireSourceSessionLifecycle: async');
    expect(reviewRegistration).toContain(
      'if (!isSecondarySessionWindowEvent(ipcEvent)) return () => {}',
    );
    expect(reviewRegistration).toContain('await acquireSendToSessionLock(sourceSessionId)');
    expect(clearHandler).toContain(
      'isSecondarySessionWindowEvent(e) || requiresActiveSessionForDispatch(opts)',
    );
    expect(clearHandler).toContain('await assertSessionActiveForManualDispatch(sid)');
    expect(registerSource).toContain('if (options?.sessionRouteLockHeld) {');
  });

  it('removes queue resume and steer dispatchers while an archived secondary window stays open', () => {
    const resumeHandler = sessionViewSource.slice(
      sessionViewSource.indexOf('const handleArchivedSafeQueueResume = useCallback('),
      sessionViewSource.indexOf('const handleArchivedSafeQueueSteer = useCallback('),
    );
    const steerHandler = sessionViewSource.slice(
      sessionViewSource.indexOf('const handleArchivedSafeQueueSteer = useCallback('),
      sessionViewSource.indexOf(
        'useEffect(() => {',
        sessionViewSource.indexOf('const handleArchivedSafeQueueSteer = useCallback('),
      ),
    );
    const chatInputStart = sessionViewSource.indexOf('<ChatInput');
    const chatInput = sessionViewSource.slice(
      chatInputStart,
      sessionViewSource.indexOf('/>', chatInputStart),
    );

    expect(resumeHandler).toContain('isArchivedSecondaryWindowInputBlocked()');
    expect(resumeHandler).toContain(
      'resumeQueue({ requireActiveSession: isSecondaryWindow() })',
    );
    expect(steerHandler).toContain('isArchivedSecondaryWindowInputBlocked()');
    expect(steerHandler).toContain(
      'steerQueuedMessage(clientId, { requireActiveSession: isSecondaryWindow() })',
    );
    expect(chatInput).toContain('blocksArchivedSecondaryWindowInput');
    expect(chatInput).toContain(': handleArchivedSafeQueueResume');
    expect(chatInput).toContain(': handleArchivedSafeQueueSteer');
  });

  it('blocks every retry and continuation entry after its task is archived', () => {
    const handlers = [
      ['const handleErrorTailContinue = useCallback(', 'const handleErrorTailDismiss = useCallback('],
      [
        'const handleSessionInterruptContinue = useCallback(',
        'const handleSessionInterruptDismiss = useCallback(',
      ],
      ['const handleRetry = useCallback(', 'const handleSwitchToClaudeSubscription = useCallback('],
      [
        'const handleSwitchToClaudeSubscription = useCallback(',
        'const handleSilentStopContinue = useCallback(',
      ],
      [
        'const handleSilentStopContinue = useCallback(',
        'const handleContinueAfterUsageReset = useCallback(',
      ],
    ] as const;

    for (const [start, end] of handlers) {
      const source = sessionViewSource.slice(
        sessionViewSource.indexOf(start),
        sessionViewSource.indexOf(end),
      );
      expect(source).toContain('isArchivedSecondaryWindowInputBlocked()');
    }
    expect(
      sessionViewSource.slice(
        sessionViewSource.indexOf('const handleErrorTailContinue = useCallback('),
        sessionViewSource.indexOf('const handleErrorTailDismiss = useCallback('),
      ),
    ).toContain('beforeEnqueue: allowArchivedSecondaryWindowEnqueue');
    expect(
      sessionViewSource.slice(
        sessionViewSource.indexOf('const handleSessionInterruptContinue = useCallback('),
        sessionViewSource.indexOf('const handleSessionInterruptDismiss = useCallback('),
      ),
    ).toContain('beforeEnqueue: allowArchivedSecondaryWindowEnqueue');
    expect(
      sessionViewSource.slice(
        sessionViewSource.indexOf('const handleSilentStopContinue = useCallback('),
        sessionViewSource.indexOf('const handleContinueAfterUsageReset = useCallback('),
      ),
    ).toContain('beforeEnqueue: allowArchivedSecondaryWindowEnqueue');
    expect(sessionViewSource).toContain(
      'retryLastError({ requireActiveSession: isSecondaryWindow() })',
    );
  });

  it('rechecks the durable active state at every Main dispatch boundary', () => {
    const enqueueStart = registerSource.indexOf('MAKER_INVOKE.INPUT_ENQUEUE');
    const enqueueEnd = registerSource.indexOf('MAKER_INVOKE.INPUT_COMPACT', enqueueStart);
    const enqueueBody = registerSource.slice(enqueueStart, enqueueEnd);
    const enqueueFence = enqueueBody.indexOf('await assertSessionActiveForManualDispatch(sid);');
    const enqueueDispatch = enqueueBody.indexOf('inputCoordinator.enqueue(sid, queued');

    const steerStart = registerSource.indexOf('MAKER_INVOKE.INPUT_STEER');
    const steerEnd = registerSource.indexOf('MAKER_INVOKE.INPUT_STOP', steerStart);
    const steerBody = registerSource.slice(steerStart, steerEnd);
    const steerFence = steerBody.indexOf('await assertSessionActiveForManualDispatch(sid);');
    const steerDispatch = steerBody.indexOf('inputCoordinator.steer(');

    const directFence = makerSendTransactionSource.indexOf(
      'await deps.assertSessionActiveForManualDispatch?.(sessionId);',
    );
    const directDispatch = makerSendTransactionSource.indexOf(
      'const sendResult = await sess.send(',
    );
    const acceptedSteerStart = registerSource.indexOf('const steerToAgentAccepted = async');
    const steerMetadataRead = registerSource.indexOf(
      'const meta = await maker.getSessionMeta(sessionId).catch(() => null);',
      acceptedSteerStart,
    );
    const finalSteerFence = registerSource.indexOf(
      'await assertSessionActiveForManualDispatch(sessionId);',
      steerMetadataRead,
    );
    const finalSteerLock = registerSource.indexOf(
      'await withSendToSessionLock(sessionId, async () => {',
      steerMetadataRead,
    );
    const vendorSteer = registerSource.indexOf(
      'await sess.steer(steerPayload as never,',
      finalSteerFence,
    );
    const finalSteerLockEnd = registerSource.indexOf(
      "\n      });\n      log.info('steer: delivered'",
      vendorSteer,
    );

    expect(enqueueFence).toBeGreaterThan(-1);
    expect(enqueueDispatch).toBeGreaterThan(enqueueFence);
    expect(steerFence).toBeGreaterThan(-1);
    expect(steerDispatch).toBeGreaterThan(steerFence);
    expect(directFence).toBeGreaterThan(-1);
    expect(directDispatch).toBeGreaterThan(directFence);
    expect(acceptedSteerStart).toBeGreaterThan(-1);
    expect(steerMetadataRead).toBeGreaterThan(-1);
    expect(finalSteerLock).toBeGreaterThan(steerMetadataRead);
    expect(finalSteerFence).toBeGreaterThan(finalSteerLock);
    expect(vendorSteer).toBeGreaterThan(finalSteerFence);
    expect(finalSteerLockEnd).toBeGreaterThan(vendorSteer);
    expect(makerChatStoreSource).toContain(
      '...(opts?.requireActiveSession ? { requireActiveSession: true } : {})',
    );
    expect(registerSource).toContain('delete normalized.requireActiveSession;');
    expect(enqueueBody).toContain('{ requireActiveSession: true }');
  });

  it('fences secondary-window /context at the Main dispatch boundary without changing primary semantics', () => {
    const handlerStart = registerSource.indexOf('MAKER_INVOKE.GET_CONTEXT_USAGE');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = registerSource.indexOf(
      'ipcMain.handle(',
      handlerStart + 'MAKER_INVOKE.GET_CONTEXT_USAGE'.length,
    );
    const handlerBody = registerSource.slice(handlerStart, handlerEnd);

    // fence 判定必须在任何 session 查找 / lazy-bootstrap 之前,且同时认两路信号:
    // 本机副窗口按 sender(isSecondarySessionWindowEvent)、device-link 远程副窗口
    // sender 为空,靠显式 fenceOpts.requireActiveSession 驱动。
    const secondaryProbe = handlerBody.indexOf('isSecondarySessionWindowEvent(e)');
    expect(secondaryProbe).toBeGreaterThan(-1);
    const explicitMarkerProbe = handlerBody.indexOf('requireActiveSession === true');
    expect(explicitMarkerProbe).toBeGreaterThan(-1);
    expect(handlerBody).toContain('const requireActiveFence =');
    const fenceAssigned = handlerBody.indexOf('const requireActiveFence =');
    const sessionLookup = handlerBody.indexOf('maker.getSession(sessionId)');
    expect(sessionLookup).toBeGreaterThan(fenceAssigned);

    // 触发 fence 的路径走与 send/steer 同一条 route lock + durable active 复核。
    expect(handlerBody).toContain('if (!requireActiveFence) return run();');
    const lockStart = handlerBody.indexOf(
      'return withSendToSessionLock(sessionId, async () => {',
      fenceAssigned,
    );
    expect(lockStart).toBeGreaterThan(-1);
    const activeCheck = handlerBody.indexOf(
      'await assertSessionActiveForManualDispatch(sessionId);',
      lockStart,
    );
    expect(activeCheck).toBeGreaterThan(lockStart);
    const runInsideLock = handlerBody.indexOf('return run();', activeCheck);
    expect(runInsideLock).toBeGreaterThan(activeCheck);

    // lazy-bootstrap(会重建 agent 进程)被包在 run() 内,所以 fence 命中时会在拿到
    // 锁后被 active 复核拦截,bootstrapSession 不可能执行。
    expect(handlerBody.indexOf('await bootstrapSession(co)')).toBeGreaterThan(sessionLookup);
    expect(handlerBody.indexOf('await reconcileCreateOptsAgainstDb(sessionId, co)')).toBeGreaterThan(
      sessionLookup,
    );

    // 主窗口与未带标记的 primary remote 路径不被 fence 包裹,保留历史 /context 可重新
    // 激活会话的语义。
    const nonFenceReturn = handlerBody.indexOf('if (!requireActiveFence) return run();');
    expect(nonFenceReturn).toBeGreaterThan(-1);
    expect(nonFenceReturn).toBeLessThan(lockStart);
  });

});
