/**
 * makerEventHotPathOrdering.test.ts
 * ---------------------------------------------------------------------------
 * Remaining production wiring and pricing characterization guards. Event ordering,
 * failure ownership and provider admission run as behavioral tests in
 * maker-ipc/__tests__/sessionEventPipeline.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'maker-ipc', 'register.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const registerSource = source;
const usageSourcePath = resolve(__dirname, '..', 'maker-ipc', 'usage.ts');
const usageSource = readFileSync(usageSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const hookControlSourcePath = resolve(__dirname, '..', 'hook-control', 'ipc.ts');
const hookControlSource = readFileSync(hookControlSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const bootstrapSourcePath = resolve(__dirname, '..', 'bootstrap-electron.ts');
const bootstrapSource = readFileSync(bootstrapSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const goalStorageSourcePath = resolve(__dirname, '..', 'goal-host', 'storage.ts');
const goalStorageSource = readFileSync(goalStorageSourcePath, 'utf8').replace(/\r\n?/g, '\n');

describe('maker:event hot path ordering', () => {
  it('keeps complete PI Subagent returns on the host side of the event boundary', () => {
    const redactor = source.slice(
      source.indexOf('function redactEventForRenderer'),
      source.indexOf('\nfunction ', source.indexOf('function redactEventForRenderer') + 1),
    );
    expect(redactor).toContain('delete rendererEvent.sessionTurnGeneration;');
    expect(redactor).toContain('delete rendererEvent.sessionInstanceId;');
    for (const key of [
      'subagentObservation',
      'returnedResult',
      'returnedResultEmpty',
      'returnedResultTruncated',
    ]) {
      expect(redactor).toContain(`'${key}'`);
    }
  });

  it('rewires a replacement Session instance that retains the same business id', () => {
    const wireSessionSource = extractWireSessionSource();

    // Instance ownership and teardown failures are exercised by
    // sessionBindingLifecycle.test.ts; retain the production adapter wiring guard.
    expect(wireSessionSource).toContain(
      'const registration = sessionBindings.beginBinding(session);',
    );
    expect(wireSessionSource).toContain('if (!registration) return;');
    expect(wireSessionSource).toMatch(
      /registration\.disposers\.push\(\s*session\.onEvent\(\(event: AgentEvent\) => \{/,
    );
    expectOrder(
      wireSessionSource,
      'sessionBindings.attachStatusListener(registration);',
      'installDesktopInteractionListener(session);',
    );
    // #1286:拆线(实例替换 / 会话关闭)必须给插件补 did-turn-end,否则订阅方的
    // 「AI 在忙」外层状态永久卡在 working,除重启没有自愈手段。同一个 disposer 里
    // 摘 interaction observer(#1283),不摘会让 activity 的审批边界发给已拆线的 tap。
    const tapDisposerIndex = wireSessionSource.indexOf('ghostSessionTap.dispose();');
    expect(tapDisposerIndex).toBeGreaterThanOrEqual(0);
    expect(
      wireSessionSource.lastIndexOf('registration.disposers.push(', tapDisposerIndex),
    ).toBeGreaterThanOrEqual(0);
    expect(wireSessionSource).toContain('installInteractionLifecycleObserver(session, null);');
    expectOrder(
      wireSessionSource,
      'if (isFencedStaleSessionTerminal(session.id, event)) return;',
      'ghostSessionTap.handleEvent(',
    );
  });

  it('keeps the remaining runtime close adapter in its original domain order', () => {
    const start = source.indexOf('function cleanupClosedSessionRuntime(');
    const end = source.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    let previous = -1;
    for (const call of [
      'pendingCredentialSwitchHolder?.onSessionClosed(',
      'deferredCodexRestartHolder?.onSessionSettled(',
      'agentInputCoordinatorHolder?.onExternalTurnSettled(',
      'refreshRemoteCodexMcpOnTurnSettledHolder?.(',
      'gitSnapshotCoordinator?.onSessionClosed(',
      'clearOrcaMcpHydrated(',
      'knownNonOrcaSessionIds.delete(',
      'lastReportedCostUsdBySession.delete(',
      'lastReportedModelUsageBySession.delete(',
      'turnModelPromiseBySession.delete(',
      'turnPiFastModeBySession.delete(',
      'productTurnWallClockTracker.clear(',
      'productTurnUsageTargetTracker.clear(',
      'claudeOutputLagTimingGuard.clear(',
      'clearClaudeSessionBackgroundActivity(',
      'clearSessionPersistState(',
      'clearSubagentObservationRewindState(',
      'handleAgentIslandSessionClosedAfterCleanup(',
    ]) {
      const index = body.indexOf(call);
      expect(index, call).toBeGreaterThan(previous);
      previous = index;
    }
  });
  // runs the paid-model fence in the shared Session lifecycle boundary: covered by the executable sessionEventPipeline tests.

  // rejects a fenced leftover terminal before register-side turn effects: covered by the executable sessionEventPipeline tests.

  // broadcasts EVENT before usage/context/island/idle side effects: covered by the executable sessionEventPipeline tests.

  // tracks Claude wall clock across continuation segments and only consumes it at product completion: covered by the executable sessionEventPipeline tests.
  it('preserves the product clock before a silent-stop continuation can emit running', () => {
    const start = source.indexOf('async function handleSilentStopTurnEnd(');
    const continuation = source.slice(start, source.indexOf('\nfunction ', start + 1));
    expectOrder(
      continuation,
      'productTurnWallClockTracker.preserveForContinuation(session.id);',
      'const sendResult = await session.send(',
    );
  });

  it('uses the assistant API message id as Vertex output-lag evidence', () => {
    const wireSessionSource = readEventModule('sessionClaudeTurnUsage');

    expect(wireSessionSource).toContain('assistant_message_id?: unknown;');
    expect(wireSessionSource).toContain("typeof doneData?.assistant_message_id === 'string'");
    expect(wireSessionSource).toContain('? doneData.assistant_message_id');
    expect(wireSessionSource).toContain('doneData?.is_error !== true');
  });
  // wakes deferred Goal resumes from the shared product-terminal idle boundary: covered by the executable sessionEventPipeline tests.

  it('wakes deferred Goal resumes after direct-abort and authoritative-idle reconciliation', () => {
    const observerHelperStart = source.indexOf('function notifyGoalIdleAfterTurnSettled(');
    const observerHelperEnd = source.indexOf('\n}\n', observerHelperStart) + 2;
    const observerHelperSource = source.slice(observerHelperStart, observerHelperEnd);
    const reconcileStart = source.indexOf('const sealLostTerminalPersistState =');
    const reconcileEnd = source.indexOf('\n\n  const readDirectAbortTurnId =', reconcileStart);
    const reconcileSource = source.slice(reconcileStart, reconcileEnd);
    const directAbortStart = source.indexOf('ipcMain.handle(MAKER_INVOKE.ABORT_SESSION');
    const directAbortEnd = source.indexOf(
      '\n  ipcMain.handle(MAKER_INVOKE.CLOSE_SESSION',
      directAbortStart,
    );
    const directAbortSource = source.slice(directAbortStart, directAbortEnd);
    const coordinatorStart = source.indexOf('const inputCoordinator:');
    const coordinatorEnd = source.indexOf(
      '\n  agentInputCoordinatorHolder = inputCoordinator;',
      coordinatorStart,
    );
    const coordinatorSource = source.slice(coordinatorStart, coordinatorEnd);

    expect(observerHelperStart).toBeGreaterThanOrEqual(0);
    expect(observerHelperEnd).toBeGreaterThan(observerHelperStart);
    expect(observerHelperSource).toContain('goalIdleObserver?.(sessionId);');
    expect([...source.matchAll(/goalIdleObserver\?\.\(sessionId\);/g)]).toHaveLength(1);

    expect(reconcileStart).toBeGreaterThanOrEqual(0);
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);
    const liveIdleStart = reconcileSource.indexOf(
      'sessionTurnActivityTracker.setSessionInTurn(sessionId, false);',
    );
    expect(liveIdleStart).toBeGreaterThanOrEqual(0);
    expect(
      reconcileSource.indexOf('notifyGoalIdleAfterTurnSettled(sessionId);', liveIdleStart),
    ).toBeGreaterThan(liveIdleStart);
    expectOrder(
      reconcileSource,
      'sealAssistantBlockForLateFinal(sessionId, null);',
      'consumeLastAssistantPersistId(sessionId);',
    );
    expectOrder(
      reconcileSource,
      'clearCodexPlanRowsForSession(sessionId);',
      'resetTurnPersistState(sessionId);',
    );
    expectOrder(
      reconcileSource,
      'sealLostTerminalPersistState(sessionId);',
      'sessionTurnActivityTracker.deleteSession(sessionId);',
    );

    // ABORT_SESSION reconciles from finally, so vendor abort rejection still reaches the
    // shared idle wake-up once the exact Session/generation boundary proves idle.
    expect(directAbortStart).toBeGreaterThanOrEqual(0);
    expect(directAbortEnd).toBeGreaterThan(directAbortStart);
    expect(directAbortSource).toMatch(
      /finally \{[\s\S]*reconcileDirectAbortBoundary\(sessionId, directAbortBoundary, 'direct-abort'\);/,
    );
    expect(source).toContain('reconciledIdle = reconcileSessionTurnIdle(sessionId, source);');

    // Coordinator NO_ACTIVE_TURN / settled-abort fallback shares the same reconciliation exit.
    expect(coordinatorStart).toBeGreaterThanOrEqual(0);
    expect(coordinatorEnd).toBeGreaterThan(coordinatorStart);
    expect(coordinatorSource).toContain(
      "return reconcileSessionTurnIdle(sessionId, 'authoritative-idle');",
    );
    expect(coordinatorSource).toContain('isLiveTurnRunning: (sessionId) =>');
    expect(coordinatorSource).toContain('isLiveSessionPresent: (sessionId) =>');
    expect(source).toContain('lookupStableSessionForTurnBoundary');
    expect(source).toContain("status: 'unavailable'");
    expect(coordinatorSource).toContain("if (lookup.status === 'unavailable') return undefined;");
    expect(coordinatorSource).toContain("if (lookup.status === 'missing') return false;");
    expect(coordinatorSource).toContain("return lookup.status === 'found';");
  });
  // does not latch product-turn bookkeeping on background status events: covered by the executable sessionEventPipeline tests.

  // persists a terminal Codex plan before clearing its turn-owned lookup maps: covered by the executable sessionEventPipeline tests.

  it('defers remote auth island errors until the renderer reports retry failure', () => {
    const wireSessionSource = readEventModule('sessionEventPreparation');
    const deferredHandler = source.match(
      /ipcMain\.handle\(\s*MAKER_INVOKE\.PERSIST_TURN_ERROR_DEFERRED,[\s\S]*?\n\s*\}\);/,
    )?.[0];

    expect(source).toContain('function isRemoteAuthRetryErrorEvent(');
    expect(source).toContain("if (session.agentKind === 'codex') return false;");
    expect(source).toContain('service.deferRemoteAuthRetryError(meta, event);');
    expect(wireSessionSource).toContain(
      'isRemoteAuthRetry = isRemoteAuthRetryErrorEvent(session, event);',
    );
    expect(deferredHandler).toBeTruthy();
    expect(deferredHandler).toContain(
      'getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);',
    );
    expect(deferredHandler).toContain('return persistId;');
    expectOrder(
      deferredHandler ?? '',
      'onTurnErrorEvent(sid, errData, agentMeta);',
      'getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);',
    );
    expectOrder(
      deferredHandler ?? '',
      'getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);',
      'return persistId;',
    );
  });

  it('keeps auto-resume-owned terminal errors out of Agent Island until they are final', () => {
    const source = registerSource + readEventModule('sessionEventTerminal');
    const handler = source.match(
      /function handleAgentIslandEventAfterBroadcast\([\s\S]*?\n}\n\nfunction surfaceSuppressedAutoResumeErrorInAgentIsland/,
    )?.[0];
    expect(handler).toBeTruthy();
    if (!handler) return;

    expectOrder(
      handler,
      'service.deferRemoteAuthRetryError(meta, event);',
      'const terminalError =',
    );
    expect(handler).toContain(
      'agentInputCoordinatorHolder?.isAutoResumePending(session.id) === true',
    );
    expect(handler).toContain(
      'agentInputCoordinatorHolder?.isAutoResumeDeferred(session.id) === true',
    );
    expect(handler).toContain('autoResumeBookkeeping.shouldSuppressAgentIslandError(session.id)');
    expect(handler).toContain(
      'autoResumeBookkeeping.shouldSuppressAgentIslandCompletionTail(session.id)',
    );
    expect(handler).toContain('(terminalError && autoResumeOwnsError)');
    expect(handler).toContain(
      '(isAgentIslandCompletionTail(event) && autoResumeOwnsCompletionTail)',
    );
    expectOrder(handler, 'const autoResumeOwnsError =', 'service.handleAgentEvent(meta, event);');
    expect(handler).not.toContain('suppressErrorSound');

    expect(source).toContain('surfaceSuppressedAutoResumeErrorInAgentIsland(sessionId, detail)');
    expect(source).toContain('data: { ...detail, isTerminal: true }');
    expect(source).toContain(
      'autoResumeBookkeeping.claimSuppressedErrorForRetry(sessionId, clientId, source);',
    );
    expect(source).toContain('if (!attempt.isCurrent()) {');
    expect(source).toContain(
      'autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(sessionId);',
    );
    expect(source).toContain(
      'autoResumeBookkeeping.markReplacementDispatching(sessionId, clientId);',
    );
    expect(source).toContain(
      'autoResumeBookkeeping.surfaceSuppressedErrorForRetry(sessionId, item.clientId);',
    );
    expect(source).toContain('onRejectedUserTurn: (sessionId, item) => {');
    expect(source).toContain('commitUserPromptPreview: (sessionId, clientId) => {');
    expect(source).toContain(
      'autoResumeBookkeeping.discardSuppressedErrorForRetry(sessionId, clientId);',
    );
    expect(source).toContain(
      'autoResumeBookkeeping.discardReplacementProvenByProviderEvent(session.id);',
    );
    expect(source).not.toContain('autoResumeBookkeeping.discardSuppressedError(sessionId);');
    expect(source).toContain(
      'deferredOrcaWorkerTerminal = autoResumeBookkeeping.stashOrcaSuppressedTerminal(',
    );
    expect(source).toContain('finalizeOrcaSuppressedTerminal: (sessionId, payload) => {');
    expect(source).toContain('shouldSkipOrcaWorkerTerminal({');
    expect(source).toContain('stashedThisErrorEvent: deferredOrcaWorkerTerminal');
    expect(source).toContain('isPairedFailedTurnDone,');
    expect(source).toContain('isFailedTurnCompletionTail,');
    expect(source).toContain('autoResumeBookkeeping.consumeFailedTurnCompletionTail(');
    expect(source).toContain('event.sessionTurnGeneration');
    expect(source).toContain(
      'hasSuppressedError: autoResumeBookkeeping.hasSuppressedError(session.id)',
    );
  });
  // only status/done/error paths request idle restore: covered by the executable sessionEventPipeline tests.

  // does not persist remote Codex account snapshots into local account usage: covered by the executable sessionEventPipeline tests.

  // fires git snapshots only from post-broadcast product-terminal done events: covered by the executable sessionEventPipeline tests.

  it('uses status turn-start snapshots only as a fallback when no baseline is pending', () => {
    const wireSessionSource = readEventModule('sessionEventPreparation');
    const turnStartIndex = wireSessionSource.indexOf(
      'gitSnapshotCoordinator?.onTurnStart(session.id);',
    );
    const pendingCheckIndex = wireSessionSource.indexOf(
      'gitSnapshotCoordinator?.hasPendingTurnStart(session.id)',
    );

    expect(turnStartIndex).toBeGreaterThanOrEqual(0);
    expect(pendingCheckIndex).toBeGreaterThanOrEqual(0);
    expect(pendingCheckIndex).toBeLessThan(turnStartIndex);
  });
  // clears pending git snapshot baselines only after terminal error broadcast: covered by the executable sessionEventPipeline tests.

  // writes one durable Assistant boundary for both success and terminal error: covered by the executable sessionEventPipeline tests.

  // reserves terminal error persistId before EVENT broadcast and writes after: covered by the executable sessionEventPipeline tests.

  it('rejects stale Agent Island interactions before renderer delivery', () => {
    const interactionListenerSource = extractInstallDesktopInteractionListenerSource();
    const epochCaptureIndex = interactionListenerSource.indexOf(
      'getAgentIslandService()?.captureInteractionEpoch(session.id)',
    );
    const currentEpochCheckIndex = interactionListenerSource.indexOf(
      'getAgentIslandService()?.isInteractionCurrent(',
    );
    const flushIndex = interactionListenerSource.indexOf('flushAssistantBlock(session.id);');
    const broadcastIndex = interactionListenerSource.indexOf(
      'broadcastToAllWindows(MAKER_PUSH.INTERACTION_REQUEST',
    );
    const pendingIndex = interactionListenerSource.indexOf(
      'pendingInteractionResolvers.set(req.requestId, entry);',
    );
    const islandIndex = interactionListenerSource.indexOf(
      'handleAgentIslandInteractionAfterBroadcast(',
    );

    expect(epochCaptureIndex).toBeGreaterThanOrEqual(0);
    expect(currentEpochCheckIndex).toBeGreaterThan(epochCaptureIndex);
    expect(flushIndex).toBeGreaterThan(currentEpochCheckIndex);
    expect(pendingIndex).toBeGreaterThan(flushIndex);
    expect(broadcastIndex).toBeGreaterThan(pendingIndex);
    expect(islandIndex).toBeGreaterThan(broadcastIndex);
    expect(interactionListenerSource.slice(0, broadcastIndex)).not.toContain(
      'handleInteractionRequest(',
    );
    expect(source).toContain(
      'Agent Island interaction update failed after maker interaction broadcast',
    );
  });

  it('clears git snapshot coordinator state when sessions close', () => {
    const closedBlock = extractSessionCloseAdaptersSource();

    expect(closedBlock).toContain('gitSnapshotCoordinator?.onSessionClosed(session.id);');
    expectOrder(
      closedBlock,
      'agentInputCoordinatorHolder?.onSessionClosed(session.id, options);',
      'gitSnapshotCoordinator?.onSessionClosed(session.id);',
    );
  });

  it('preserves coordinator input boundary inside the rehydrate suppression window (#1930)', () => {
    const closedBlock = extractSessionCloseAdaptersSource();

    // rehydrate / 凭证切换 close-rebuild 期间同一逻辑会话进程内重建:窗口内
    // onSessionClosed 传 preserveInputBoundary(true)保留 input boundary(不 abort
    // 驱动本次重建的 signal → #1930),但**其余清理必须照常执行**(不能整体跳过
    // onSessionClosed,否则 rebuild 失败/close 后不 rebuild 时 coordinator 残留)。
    expect(closedBlock).toContain(
      'agentInputCoordinatorHolder?.onSessionClosed(session.id, options);',
    );
    expect(closedBlock).toContain(
      'shouldPreserveInputBoundary: () => rehydrateCloseSuppression.isSuppressed(session.id),',
    );
    expectOrder(
      closedBlock,
      'agentInputCoordinatorHolder?.onSessionClosed(session.id, options);',
      'gitSnapshotCoordinator?.onSessionClosed(session.id);',
    );
  });

  it('preserves only a waiting Codex reconnect-stall retry across its exact provider rebuild', () => {
    const closedBlock = extractSessionCloseAdaptersSource();

    expect(source).toContain(
      'const pendingCodexReconnectStalledRebuilds = new WeakMap<Session, number>();',
    );
    expect(source).toContain("if (signals.reason === 'codex_reconnect_stalled') {");
    expect(source).toContain(
      'pendingCodexReconnectStalledRebuilds.set(runtimeSession, decision.attemptToken);',
    );
    expect(source).toContain("if (closeReason !== 'unexpected') return false;");
    expect(source).toContain(
      'interruptedTurnAutoResumeGuard.isCurrentAttempt(session.id, attemptToken)',
    );
    expect(source).toContain('coordinator.getAutoResumeAttemptToken(session.id) !== attemptToken');
    expect(source).toContain('autoResumeBookkeeping.hasWaitingSchedule(session.id, attemptToken)');
    expect(closedBlock).toContain(
      'shouldPreserveCodexReconnectStalledAutoResume(session, closeReason)',
    );
    expect(closedBlock).toContain(
      'shouldPreserveSessionRuntimeFallbackAutoResume(session, closeReason)',
    );
    expect(closedBlock).toContain('runSessionCloseCleanup(context.preserveAutoResumeIntent, {');
    expect(closedBlock).toContain('autoResumeBookkeeping.teardown(session.id);');
  });

  it('clears Agent Island after mandatory closed-session cleanup', () => {
    const closedBlock = extractSessionCloseAdaptersSource();
    const closeSessionHandler = source.match(
      /ipcMain\.handle\(MAKER_INVOKE\.CLOSE_SESSION,[\s\S]*?\n {2}\}\);/,
    )?.[0];

    expect(closedBlock).toContain(
      "handleAgentIslandSessionClosedAfterCleanup(session.id, 'process-closed');",
    );
    expectOrder(
      closedBlock,
      "cleanupPendingInteractionsForSession(session.id, 'session_closed')",
      "handleAgentIslandSessionClosedAfterCleanup(session.id, 'process-closed');",
    );
    expect(source).toContain(
      'Agent Island session close cleanup failed after mandatory session cleanup',
    );
    expect(closeSessionHandler).toBeTruthy();
    expect(closeSessionHandler).not.toContain('handleSessionClosed');
  });

  it('marks Agent Island stopped before provider abort tails can arrive', () => {
    const coordinatorAbortStart = source.indexOf('abortSession: async (sessionId) => {');
    const coordinatorAbortEnd = source.indexOf('\n    isTurnRunning:', coordinatorAbortStart);
    const coordinatorAbortSource = source.slice(coordinatorAbortStart, coordinatorAbortEnd);
    const directAbortStart = source.indexOf('ipcMain.handle(MAKER_INVOKE.ABORT_SESSION');
    const directAbortEnd = source.indexOf(
      '\n  ipcMain.handle(MAKER_INVOKE.CLOSE_SESSION',
      directAbortStart,
    );
    const directAbortSource = source.slice(directAbortStart, directAbortEnd);
    const hookAbortStart = hookControlSource.indexOf('abortSession: async (sessionId) => {');
    const hookAbortEnd = hookControlSource.indexOf('\n      // session.archive', hookAbortStart);
    const hookAbortSource = hookControlSource.slice(hookAbortStart, hookAbortEnd);

    expect(source).toContain('function handleAgentIslandSessionStopped(');
    expect(coordinatorAbortStart).toBeGreaterThanOrEqual(0);
    expect(coordinatorAbortEnd).toBeGreaterThan(coordinatorAbortStart);
    expectOrder(
      coordinatorAbortSource,
      'const sess = getStableSessionForTurnBoundary(sessionId);',
      'if (!sess) return;',
    );
    expectOrder(
      coordinatorAbortSource,
      'if (!sess) return;',
      'handleAgentIslandSessionStopped(sess);',
    );
    expectOrder(
      coordinatorAbortSource,
      'handleAgentIslandSessionStopped(sess);',
      'await sess.abort();',
    );
    expect(directAbortStart).toBeGreaterThanOrEqual(0);
    expect(directAbortEnd).toBeGreaterThan(directAbortStart);
    expectOrder(
      directAbortSource,
      'const sess = getStableSessionForTurnBoundary(sessionId);',
      'if (!sess) {',
    );
    expect(directAbortSource).not.toContain('const sess = maker.getSession(sessionId);');
    expectOrder(directAbortSource, 'if (!sess) {', 'handleAgentIslandSessionStopped(sess);');
    expectOrder(directAbortSource, 'handleAgentIslandSessionStopped(sess);', 'await sess.abort();');
    expect(directAbortSource).toContain(
      'const directAbortBoundary = beginDirectAbortReconciliation(sessionId, sess);',
    );
    expectOrder(
      directAbortSource,
      'const directAbortBoundary = beginDirectAbortReconciliation(sessionId, sess);',
      'await sess.abort();',
    );
    expect(directAbortSource).toContain(
      "reconcileDirectAbortBoundary(sessionId, directAbortBoundary, 'direct-abort');",
    );
    expect(directAbortSource).not.toContain("reconcileSessionTurnIdle(sessionId, 'direct-abort');");
    expect(directAbortSource).not.toContain('if (!sess.isTurnRunning())');
    expectOrder(
      directAbortSource,
      "reconcileDirectAbortBoundary(sessionId, directAbortBoundary, 'direct-abort');",
      "cleanupPendingInteractionsForSession(sessionId, 'session_aborted');",
    );
    expect(hookAbortStart).toBeGreaterThanOrEqual(0);
    expect(hookAbortEnd).toBeGreaterThan(hookAbortStart);
    expectOrder(
      hookAbortSource,
      'const session = getMaker().getSession(sessionId);',
      'if (!session) return;',
    );
    expectOrder(
      hookAbortSource,
      'if (!session) return;',
      'getAgentIslandService()?.handleSessionStopped(',
    );
    expect(hookAbortSource).toContain(
      "log.warn('Agent Island session stop update failed before hook provider abort'",
    );
    expectOrder(
      hookAbortSource,
      'getAgentIslandService()?.handleSessionStopped(',
      'await session.abort();',
    );
  });

  it('tears down every automatic recovery path before an explicit Stop aborts the session', () => {
    const resetStart = source.indexOf('function resetAutomaticRecoveryForExplicitStop(');
    const resetEnd =
      source.indexOf('\n}\n\nfunction settleUndispatchedAutoResumeOutcome', resetStart) + 2;
    const resetSource = source.slice(resetStart, resetEnd);
    const coordinatorAbortStart = source.indexOf('abortSession: async (sessionId) => {');
    const coordinatorAbortEnd = source.indexOf('\n    isTurnRunning:', coordinatorAbortStart);
    const coordinatorAbortSource = source.slice(coordinatorAbortStart, coordinatorAbortEnd);
    const inputStopStart = source.indexOf('ipcMain.handle(MAKER_INVOKE.INPUT_STOP');
    const inputStopEnd = source.indexOf(
      '\n  ipcMain.handle(MAKER_INVOKE.INPUT_RESUME',
      inputStopStart,
    );
    const inputStopSource = source.slice(inputStopStart, inputStopEnd);
    const directAbortStart = source.indexOf('ipcMain.handle(MAKER_INVOKE.ABORT_SESSION');
    const directAbortEnd = source.indexOf(
      '\n  ipcMain.handle(MAKER_INVOKE.CLOSE_SESSION',
      directAbortStart,
    );
    const directAbortSource = source.slice(directAbortStart, directAbortEnd);
    const goalPauseStart = source.indexOf('async function pauseGoalBeforeExplicitStop(');
    const goalPauseEnd = source.indexOf('\n}\n// (Option B)', goalPauseStart) + 2;
    const goalPauseSource = source.slice(goalPauseStart, goalPauseEnd);

    expect(resetStart).toBeGreaterThanOrEqual(0);
    expect(resetSource).toContain('silentStopAutoResumeGuard.noteSessionReset(sessionId);');
    expect(resetSource).toContain('interruptedTurnAutoResumeGuard.noteSessionReset(sessionId);');
    expect(resetSource).toContain('autoResumeBookkeeping.teardown(sessionId);');
    expect(source).toContain('noteSessionReset: resetAutomaticRecoveryForExplicitStop,');
    expect(source).toContain('resetAutomaticRecoveryForExplicitStop(sid);');

    expectOrder(
      coordinatorAbortSource,
      'resetAutomaticRecoveryForExplicitStop(sessionId);',
      'const sess = getStableSessionForTurnBoundary(sessionId);',
    );
    expectOrder(
      directAbortSource,
      'resetAutomaticRecoveryForExplicitStop(sessionId);',
      'const goalPause = pauseGoalBeforeExplicitStop(sessionId);',
    );
    expectOrder(
      directAbortSource,
      'const goalPause = pauseGoalBeforeExplicitStop(sessionId);',
      'const sess = getStableSessionForTurnBoundary(sessionId);',
    );
    // no-session 分支会先 await goalPause 后返回；有 live session 时真正的 abort 必须
    // 立即启动，只在 abort/reconcile 之后读取 Goal 持久化结果。
    expect(
      directAbortSource.indexOf('const settledGoalPause = await goalPauseResult;'),
    ).toBeGreaterThan(directAbortSource.indexOf('await sess.abort();'));
    expectOrder(
      inputStopSource,
      'resetAutomaticRecoveryForExplicitStop(sid);',
      'const goalPause = pauseGoalBeforeExplicitStop(sid);',
    );
    expectOrder(
      inputStopSource,
      'const goalPause = pauseGoalBeforeExplicitStop(sid);',
      'inputCoordinator.stop(',
    );
    expectOrder(inputStopSource, 'inputCoordinator.stop(', 'await goalPause;');
    expect(goalPauseStart).toBeGreaterThanOrEqual(0);
    expect(goalPauseSource).toContain('catch (err)');
    expect(goalPauseSource).toContain('await Promise.resolve(observer(sessionId));');
    expect(goalPauseSource).toContain(
      "log.error('goal pause persistence failed during explicit stop'",
    );
    expect(goalPauseSource).toContain(
      "throwIpcError('INTERNAL', 'Failed to persist the stopped Goal state');",
    );
    expect(goalPauseSource).not.toContain('throw err;');
    expect(goalPauseSource).not.toContain('Promise.race');
    expect(goalPauseSource).not.toContain('setTimeout');
    expect(directAbortSource).toContain('const goalPauseResult = goalPause.then(');
    expectOrder(
      directAbortSource,
      'await sess.abort();',
      'const settledGoalPause = await goalPauseResult;',
    );
    expectOrder(
      directAbortSource,
      'if (abortFailed)',
      'if (!settledGoalPause.ok) throw settledGoalPause.error;',
    );
  });

  it('commits a Goal state update before its post-write readback', () => {
    const updateStart = goalStorageSource.indexOf('async update(sessionId: string');
    const updateEnd = goalStorageSource.indexOf('\n  async clear(', updateStart);
    const updateSource = goalStorageSource.slice(updateStart, updateEnd);

    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateSource).not.toContain('const existing = await this.get(sessionId);');
    const writeIndex = updateSource.indexOf('await this.getDb().update(sessionGoals)');
    const postWriteReadIndex = updateSource.lastIndexOf('return this.get(sessionId);');
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(postWriteReadIndex).toBeGreaterThan(writeIndex);
  });

  it('uses the wired Session snapshot while reconciling owner-boundary aborts', () => {
    const stableLookupStart = source.indexOf('const lookupStableSessionForTurnBoundary =');
    const stableLookupEnd = source.indexOf(
      '\n  const getStableSessionForTurnBoundary =',
      stableLookupStart,
    );
    const stableLookupSource = source.slice(stableLookupStart, stableLookupEnd);
    const reconcileStart = source.indexOf('const sealLostTerminalPersistState =');
    const reconcileEnd = source.indexOf('\n\n  const inputCoordinator:', reconcileStart);
    const reconcileSource = source.slice(reconcileStart, reconcileEnd);

    expect(stableLookupStart).toBeGreaterThanOrEqual(0);
    expect(stableLookupEnd).toBeGreaterThan(stableLookupStart);
    expect(stableLookupSource).toContain('sessionBindings.getSession(sessionId)');
    expectOrder(
      stableLookupSource,
      "if (wired) return { status: 'found', session: wired };",
      "return sess ? { status: 'found', session: sess } : { status: 'missing' };",
    );
    expect(stableLookupSource).toContain("return { status: 'unavailable' };");
    expect(source).toContain("return lookup.status === 'found' ? lookup.session : null;");

    expect(reconcileStart).toBeGreaterThanOrEqual(0);
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);
    expect(reconcileSource).toContain('if (!liveSessionIdle) return false;');
    expect(reconcileSource).not.toContain(
      'if (!trackerStale && !hadZombieInteraction) return false;',
    );
    expect(reconcileSource).toContain(
      'confirmed live session idle during turn-boundary reconciliation',
    );
    expectOrder(
      reconcileSource,
      'sealAssistantBlockForLateFinal(sessionId, null);',
      'consumeLastAssistantPersistId(sessionId);',
    );
    expectOrder(
      reconcileSource,
      'consumeLastAssistantPersistId(sessionId);',
      'consumeLastTopLevelAssistantPersistId(sessionId);',
    );
    expectOrder(
      reconcileSource,
      'consumeLastTopLevelAssistantPersistId(sessionId);',
      'markAssistantTurnFailed(sessionId, abortedBoundaryAssistantPersistId)',
    );
    expectOrder(
      reconcileSource,
      'sealLostTerminalPersistState(sessionId);',
      'sessionTurnActivityTracker.deleteSession(sessionId);',
    );
    expectOrder(
      reconcileSource,
      'clearCodexPlanRowsForSession(sessionId);',
      'resetTurnPersistState(sessionId);',
    );
  });

  it('keeps direct abort reconciliation fail-closed across owner replacement and new turns', () => {
    const closeBoundaryStart = source.indexOf('function getDirectAbortBoundaryForClosingSession(');
    const closeBoundaryEnd = source.indexOf('\n}\n', closeBoundaryStart) + 2;
    const closeBoundarySource = source.slice(closeBoundaryStart, closeBoundaryEnd);
    const helperStart = source.indexOf('const readDirectAbortTurnId =');
    const helperEnd = source.indexOf('\n\n  const inputCoordinator:', helperStart);
    const helperSource = source.slice(helperStart, helperEnd);
    const wireSessionSource = readEventModule('sessionEventPreparation');
    const closedBlock = extractSessionCloseAdaptersSource();

    expect(source).toContain(
      'const sessionTurnBoundaryGenerationById = new Map<string, number>();',
    );
    expect(source).toContain(
      'const directAbortReconcileBoundaries = new Map<string, DirectAbortReconcileBoundary>();',
    );
    expect(closeBoundaryStart).toBeGreaterThanOrEqual(0);
    expect(closeBoundaryEnd).toBeGreaterThan(closeBoundaryStart);
    expect(closeBoundarySource).toContain('boundary.session !== session');
    expect(closeBoundarySource).toContain(
      'currentSessionTurnBoundaryGeneration(sessionId) !== boundary.generation',
    );
    expect(helperSource).toContain('sessionBindings.getSession(sessionId) !== boundary.session');
    expect(helperSource).toContain(
      'currentSessionTurnBoundaryGeneration(sessionId) !== boundary.generation',
    );
    expect(helperSource).toContain('direct-abort-retry');
    expect(helperSource).toContain('cancelDirectAbortReconciliation(sessionId, boundary);');
    expect(wireSessionSource).toContain(
      'if (!wasInTurn) advanceSessionTurnBoundaryGeneration(session.id);',
    );
    expectOrder(
      closedBlock,
      'const closedDirectAbortBoundary = getDirectAbortBoundaryForClosingSession(',
      'cancelDirectAbortReconciliation(session.id);',
    );
    expect(closedBlock).toContain('cancelDirectAbortReconciliation(session.id);');
    expectOrder(
      closedBlock,
      'cancelDirectAbortReconciliation(session.id);',
      'pendingFailedTurnAssistantPersistId.delete(session.id);',
    );
    expect(closedBlock).toContain('sessionTurnBoundaryGenerationById.delete(session.id);');
    expectOrder(
      closedBlock,
      'sessionTurnActivityTracker.deleteSession(session.id);',
      'notifyGoalIdle: () => notifyGoalIdleAfterTurnSettled(session.id)',
    );
    expect(closedBlock).toContain(
      'finalizeSessionClose(context.closedDirectAbortBoundary !== null, {',
    );
    expect(
      closedBlock.indexOf('notifyGoalIdle: () => notifyGoalIdleAfterTurnSettled(session.id)'),
    ).toBeGreaterThan(closedBlock.indexOf('sessionTurnBoundaryGenerationById.delete(session.id);'));
  });

  it('cancels deferred Goal resumes when non-abort session teardown supersedes them', () => {
    const replacementStart = source.indexOf('beforeReplace: (session: WiredSession) => {');
    const replacementEnd = source.indexOf('onBind: (session: WiredSession) => {', replacementStart);
    const replacementBlock = source.slice(replacementStart, replacementEnd);
    const closedBlock = extractSessionCloseAdaptersSource();

    expect(source).toContain('let goalDeferredResumeCancelObserver:');
    expect(source).toContain('export function setGoalDeferredResumeCancelObserver(');
    expect(bootstrapSource).toContain('setGoalDeferredResumeCancelObserver((sid) => {');
    expect(bootstrapSource).toContain(
      'getGoalController()?.cancelDeferredManualResume(sid, { restoreUsageResume: true });',
    );
    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(replacementEnd).toBeGreaterThan(replacementStart);
    expectOrder(
      replacementBlock,
      'cancelDirectAbortReconciliation(session.id);',
      'goalDeferredResumeCancelObserver?.(session.id);',
    );
    expect(closedBlock).toContain(
      'finalizeSessionClose(context.closedDirectAbortBoundary !== null, {',
    );
    expect(closedBlock).toContain(
      'cancelGoalResume: () => goalDeferredResumeCancelObserver?.(session.id),',
    );
  });

  it('keeps Codex subscription value out of real session cost totals', () => {
    const wireSessionSource = readEventModule('sessionCodexTurnUsage');
    const codexDoneIndex = wireSessionSource.indexOf(
      "event.type === 'done' && event.source === 'codex'",
    );
    expect(codexDoneIndex).toBeGreaterThanOrEqual(0);

    const codexDoneSource = wireSessionSource.slice(codexDoneIndex);
    expect(codexDoneSource).toContain('const sessionProvider = getSessionProvider(session.id);');
    expect(codexDoneSource).toContain(
      'const isRemoteCodexSession = Boolean(session.remoteHostId);',
    );
    expect(codexDoneSource).toContain(
      'const codexAuthInjection = isRemoteCodexSession ? null : getCodexProxyAuthInjection();',
    );
    expect(readEventModule('sessionEventPreparation')).toContain(
      '!turnModelPromiseBySession.has(session.id)',
    );
    expect(readEventModule('sessionEventPreparation')).toContain(
      'turnModelPromiseBySession.set(session.id, readSessionModelForUsage(session.id));',
    );
    expect(codexDoneSource).toMatch(
      /const modelPromise\s*=\s*turnModelPromiseBySession\.get\(session\.id\)\s*\?\?\s*readSessionModelForUsage\(session\.id\);/,
    );
    expect(codexDoneSource).toContain('turnModelPromiseBySession.delete(session.id);');
    expect(codexDoneSource).not.toContain('hasCodexOAuthLogin()');
    expect(codexDoneSource).toContain('promptTokens + completionTokens + cachedTokens');
    expect(codexDoneSource).not.toContain(
      'promptTokens + completionTokens + reasoningTokens + cachedTokens',
    );
    expect(codexDoneSource).toContain('const isCustomProviderRoute =');
    expect(codexDoneSource).toContain('isUserProviderSession(session.id)');
    expect(codexDoneSource).toMatch(/&&\s*pricingModel\.startsWith\('codex\/'\);/);
    expect(codexDoneSource).toMatch(/&&\s*isExclusiveXaiModelId\(pricingModel\);/);
    expect(codexDoneSource).toContain('const hasGatewayKey = Boolean(readClaudeApiKey());');
    expect(codexDoneSource).toContain('const hasEffectiveGatewayRoute =');
    expect(codexDoneSource).toContain('!isCustomProviderRoute');
    expect(codexDoneSource).toContain("(sessionProvider === 'xd' && hasGatewayKey)");
    expect(codexDoneSource).toMatch(/const isSubscriptionValue\s*=\s*isRemoteCodexSession\s*\|\|/);
    expect(codexDoneSource).toContain('isCodexXaiProviderRoute ||');
    // 用正则而非整串匹配:这段条件已按多行排版,单行字面量会因换行/缩进调整而假失败。
    // 要守的语义是——订阅计价只在「OpenAI 供应商 + oauth-bearer 注入 + 无生效网关路由」时成立。
    expect(codexDoneSource).toMatch(
      /isCodexOpenAiProviderRoute\s*&&\s*codexAuthInjection === 'oauth-bearer'\s*&&\s*!hasEffectiveGatewayRoute/,
    );
    expect(codexDoneSource).toContain('const modelUsageKey = isSubscriptionValue');
    expect(codexDoneSource).toContain('? codexSubscriptionUsageModelKey(pricingModel)');
    expect(codexDoneSource).toContain(': codexApiUsageModelKey(pricingModel)');
    expect(codexDoneSource).toContain('const price = isCodexXaiProviderRoute');
    expect(codexDoneSource).toContain(
      "? getSubscriptionDirectValuePrice(pricingModel, 'codex', pricing)",
    );
    // 订阅估值按显式来源取各自 registry 日期定价:内置 anthropic(access.kind=subscription)
    // 不再被记成 #billing=api;默认/openai 仍走 OpenAI 价表。
    expect(codexDoneSource).toContain("sessionProviderAccessKind === 'subscription'");
    expect(codexDoneSource).toContain('isCodexSubscriptionAccessRoute ||');
    expect(codexDoneSource).toMatch(
      /\? getCodexProviderSubscriptionValuePrice\(\s*subscriptionValueProviderId,\s*pricingModel,\s*pricing,\s*\)/,
    );
    expect(codexDoneSource).toContain("? getModelPriceQuote(pricing, 'xd', pricingModel)");
    expect(codexDoneSource).toContain(
      "? getModelPriceQuote(pricing, sessionProvider, pricingModel, 'codex')",
    );
    expect(codexDoneSource).toContain('const pricing = isSubscriptionValue');
    expect(codexDoneSource).not.toContain('isSubscriptionValue && !isCodexXaiProviderRoute');
    expect(codexDoneSource).toContain('? getReferenceModelPricing()');
    expect(codexDoneSource).toContain('? await getGatewayModelPricingForModel()');
    expect(codexDoneSource).toContain('price ?? undefined');
    expect(codexDoneSource).toMatch(
      /u\.segments !== undefined && codexSegmentsReliable\s*\? codexUsageSegments\s*:\s*\[\]/,
    );
    expect(codexDoneSource).toContain(
      "if (money && (isSubscriptionValue || price?.source === 'gateway'))",
    );
    expect(codexDoneSource).toContain(
      "const isActualApiCost = !isSubscriptionValue && price?.source === 'gateway';",
    );
    expect(codexDoneSource).toContain('if (isActualApiCost)');
    expect(codexDoneSource).toContain('void recordTurnSpend(money);');
    expect(codexDoneSource).toContain('void recordSessionTurnSpend(session.id, money);');
    expect(codexDoneSource).toMatch(
      /await recordModelTurnUsage\(\{\s*agentKind: 'codex',\s*model: modelUsageKey,\s*money: isSubscriptionValue \? unpricedSubscriptionValueMarker\(\) : undefined,\s*inputTokensDelta: promptTokens,\s*outputTokensDelta: completionTokens,\s*cacheReadTokensDelta: cachedTokens,\s*cacheCreateTokensDelta: 0,\s*\}\)\.finally\(\(\) => rebroadcastCodexTodayUsage\(\)\);[\s\S]*?const pricing = isSubscriptionValue/,
    );
    expect(codexDoneSource).toMatch(
      /await recordModelTurnUsage\(\{\s*agentKind: 'codex',\s*model: modelUsageKey,\s*money,\s*inputTokensDelta: 0,\s*outputTokensDelta: 0,\s*cacheReadTokensDelta: 0,\s*cacheCreateTokensDelta: 0,\s*\}\);/,
    );
    const costRecordIndex = codexDoneSource.indexOf('void recordTurnSpend(money);');
    const modelCostRecordIndex = codexDoneSource.indexOf(
      "if (money && (isSubscriptionValue || price?.source === 'gateway'))",
    );
    const schedulerCostRecordIndex = codexDoneSource.indexOf('await recordSchedulerTurnCost({');
    expect(costRecordIndex).toBeGreaterThanOrEqual(0);
    expect(modelCostRecordIndex).toBeGreaterThanOrEqual(0);
    expect(modelCostRecordIndex).toBeGreaterThan(
      codexDoneSource.indexOf('const pricing = isSubscriptionValue'),
    );
    expect(schedulerCostRecordIndex).toBeGreaterThan(costRecordIndex);
    expect(codexDoneSource).toContain('clientId: turnAssistantPersistId');
    expect(codexDoneSource).toContain('money,');
    expect(codexDoneSource).toMatch(
      /const hasEffectiveGatewayRoute\s*=\s*!isRemoteCodexSession\s*&&\s*!isCustomProviderRoute\s*&&/,
    );
    expect(codexDoneSource).toContain('const isCodexXaiProviderRoute =');
    expect(codexDoneSource).toMatch(
      /codexAuthInjection === 'env-key'\s*\|\|\s*isCodexBudgetRoute\s*\|\|\s*\(sessionProvider === 'xd' && hasGatewayKey\)/,
    );
    expect(codexDoneSource).not.toContain("sessionProvider !== 'xai'");
    expect(codexDoneSource).not.toContain('isEstimate: true');
  });

  it('claude-code 费用按完整请求段定价，累计 cost 首帧只建基线', () => {
    const wireSessionSource = readEventModule('sessionClaudeTurnUsage');
    const claudeDoneIndex = wireSessionSource.indexOf(
      "event.type === 'done' && event.source === 'claude-code'",
    );
    expect(claudeDoneIndex).toBeGreaterThanOrEqual(0);
    const claudeDoneSource = wireSessionSource.slice(claudeDoneIndex);
    // 主路径:按真实 provider / billing route 取价，所有 sink 共用区域金额结果。
    expect(claudeDoneSource).toContain('const billingRoute: BillingRoute = session.remoteHostId');
    expect(claudeDoneSource).toContain("billingRoute === 'xd-gateway'");
    expect(claudeDoneSource).toContain('await getGatewayModelPricingForModel()');
    expect(claudeDoneSource).toContain(': getReferenceModelPricing();');
    expect(claudeDoneSource).toContain(
      'const { turnMoney, estimatedTurnMoney, perModel } = resolveClaudeTurnCostSinks(',
    );
    expect(claudeDoneSource).toContain('providerId: sessionProviderForBilling');
    expect(claudeDoneSource).toContain('billingRoute,');
    expect(claudeDoneSource).toContain(
      'const claudeUsageSegments = normalizeTurnUsageSegments(doneData?.usageSegments);',
    );
    expect(claudeDoneSource).toContain('recordTurnSpend(turnMoney);');
    expect(claudeDoneSource).toContain('recordSessionTurnSpend(session.id, turnMoney);');
    expect(claudeDoneSource).toContain('subscriptionEstimate ?? unpricedSubscriptionValueMarker()');
    expect(claudeDoneSource).toContain('money: modelRowMoney,');
    // 订阅轮 (Claude Anthropic 订阅或 bridge 订阅直连) 打 #billing=subscription 标记,
    // 仪表盘按订阅估算价折算; 其余轮仍写归一化裸 id。
    expect(claudeDoneSource).toMatch(
      /model:\s*isClaudeSubscriptionValueRow \|\| isBridgeSubscriptionRow\s*\?\s*claudeSubscriptionUsageModelKey\(m\.model\)\s*:\s*m\.model,/,
    );
    expect(claudeDoneSource).toContain(
      'isClaudeSubscriptionSession && !m.money && isAnthropicModel(m.model)',
    );
    expect(claudeDoneSource).toContain(
      "m.source === 'subscription' && isSubscriptionDirectRoute(m.model)",
    );
    expect(claudeDoneSource).toContain('const subscriptionTurnEstimates: RegionalMoney[] = [];');
    expect(claudeDoneSource).toMatch(
      /computePriceQuoteTurnMoney\(\s*m\.deltas,\s*getSubscriptionValuePriceFor\('claude-code', m\.model, pricing\),\s*currentLedgerCurrency\(\),\s*m\.segments,\s*\)/,
    );
    // 订阅判定对齐 proxy 路由: 显式选 Anthropic, 或默认路由优先按 observed route, 未观察再回落无网关 key 启发式
    expect(claudeDoneSource).toContain("sessionProviderForBilling === 'anthropic'");
    expect(claudeDoneSource).toContain('const observedClaudeRoute =');
    expect(claudeDoneSource).toContain('readClaudeSessionRoute(session.id)');
    expect(claudeDoneSource).toContain("observedClaudeRoute === 'subscription'");
    expect(claudeDoneSource).toContain(': !readClaudeApiKey()');
    // 纯订阅轮无 recordTurnSpend push, 模型行落库后重广播今日 spend 触发仪表盘刷新
    expect(claudeDoneSource).toContain(
      'void Promise.allSettled(modelUsageWrites).then(() => rebroadcastTodaySpend());',
    );
    // 保留 #216 的 tooltip token/cache 明细。
    expect(claudeDoneSource).toContain('buildClaudeTurnUsageDetails(');
    // 窄兜底: total_cost_usd 是进程累计；首次只建基线，且累计 usage 不得冒充本轮 token。
    expect(claudeDoneSource).toMatch(
      /const rawDelta\s*=\s*prevReportedCost === undefined\s*\? 0\s*:\s*Math\.max\(0, cumulative - prevReportedCost\);/,
    );
    const claudeCostFallback = claudeDoneSource.slice(
      claudeDoneSource.indexOf("} else if (typeof cumulative === 'number' && cumulative >= 0)"),
    );
    expect(claudeCostFallback).toMatch(
      /buildClaudeTurnUsageDetails\(\s*undefined,\s*undefined,\s*resolvedModel,/,
    );
    expect(claudeCostFallback).toContain("if (route !== 'provider-api')");
  });

  it('pi subscription turns estimate value from the shared reference-price helper', () => {
    const wireSessionSource = readEventModule('sessionPiTurnUsage');
    const piDoneIndex = wireSessionSource.indexOf("event.type === 'done' && event.source === 'pi'");
    expect(piDoneIndex).toBeGreaterThanOrEqual(0);
    const piDoneSource = wireSessionSource.slice(piDoneIndex);
    expect(piDoneSource).toContain(
      '(turnPiFastModeBySession.get(session.id) ?? getSessionFastMode(session.id))',
    );
    expect(piDoneSource).toContain('turnPiFastModeBySession.delete(session.id);');
    expect(piDoneSource).toContain(
      "segment.priceVariant ?? (segment.id?.startsWith('pi:') ? piPriceVariant : 'standard'),",
    );
    expect(piDoneSource).toMatch(/const pricing\s*=\s*billingRoute === 'xd-gateway'/);
    expect(piDoneSource).toContain(': getReferenceModelPricing();');
    expect(piDoneSource).toContain("getSubscriptionValuePriceFor('pi', model, pricing)");
    expect(piDoneSource).toContain(
      'const pricingSegments = piSegmentsReliable ? group.segments : [];',
    );
    expect(piDoneSource).toContain('money = resolveTurnCost({');
    expect(piDoneSource).toContain('segments: pricingSegments,');
    expect(piDoneSource).toContain(
      "billingRoute === 'provider-api' ? undefined : group.sdkCostUsd",
    );
    expect(piDoneSource).toContain('money ?? unpricedSubscriptionValueMarker()');
    expect(piDoneSource).toContain('money: modelRowMoney,');
    expect(piDoneSource).toContain('if (actualMoney)');
    expect(piDoneSource).toContain('await recordSchedulerTurnCost({');
  });

  it('refreshes Claude credential cache before dropping mismatched header snapshots', () => {
    const listenerSource = usageSource.match(
      /setClaudeRateLimitHeadersListener\(\(snapshot, requestBearerToken\) => \{[\s\S]*?\n {2}\}\);/,
    )?.[0];
    expect(listenerSource).toBeTruthy();
    if (!listenerSource) return;

    expect(listenerSource).toContain('let currentToken = _currentClaudeToken;');
    expect(listenerSource).toContain(
      'currentToken = readClaudeCredentialsInfo()?.accessToken ?? null;',
    );
    expectOrder(
      listenerSource,
      'currentToken = readClaudeCredentialsInfo()?.accessToken ?? null;',
      'if (requestBearerToken !== currentToken) return false;',
    );
  });
});

/** Checks the production adapters; close ordering itself is tested by executing the service. */
function extractSessionCloseAdaptersSource(): string {
  const start = source.indexOf('captureCloseContext: (session: WiredSession) => {');
  const end = source.indexOf('export function wireSessionToIpc', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function extractWireSessionSource(): string {
  const wireSessionSource = source.match(
    /export function wireSessionToIpc\([\s\S]*?export const wireSessionToIpcExternal = wireSessionToIpc;/,
  )?.[0];
  expect(wireSessionSource).toBeTruthy();
  if (!wireSessionSource) {
    throw new Error('wireSessionToIpc source block not found');
  }
  return wireSessionSource;
}

function extractInstallDesktopInteractionListenerSource(): string {
  const listenerSource = source.match(
    /export function installDesktopInteractionListener\([\s\S]*?\n}\n\n\/\*\*\n \* 把 session 接进 IPC 转发链路/,
  )?.[0];
  expect(listenerSource).toBeTruthy();
  if (!listenerSource) {
    throw new Error('installDesktopInteractionListener source block not found');
  }
  return listenerSource;
}

function expectOrder(sourceBlock: string, firstNeedle: string, secondNeedle: string): void {
  const first = sourceBlock.indexOf(firstNeedle);
  const second = sourceBlock.indexOf(secondNeedle);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(second);
}

/** Existing domain guards ignore only the injected service qualifier. */
function readEventModule(name: string): string {
  return readFileSync(resolve(__dirname, '..', 'maker-ipc', name + '.ts'), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replaceAll('deps.', '');
}
