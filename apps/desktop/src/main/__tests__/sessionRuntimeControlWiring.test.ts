import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainRoot = resolve(__dirname, '..');
const bootstrapSource = readFileSync(resolve(mainRoot, 'bootstrap-electron.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);
const registerSource = readFileSync(resolve(mainRoot, 'maker-ipc/register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function handlerBody(source: string, channel: string, nextChannel: string): string {
  const start = source.indexOf(channel);
  const end = source.indexOf(nextChannel, start + channel.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('session runtime control wiring', () => {
  it('guards every fallback setting IPC before reading or mutating the setting', () => {
    for (const [channel, nextChannel] of [
      [
        'MAKER_IPC_INVOKE.SESSION_RUNTIME_FALLBACK_GET',
        'MAKER_IPC_INVOKE.SESSION_RUNTIME_FALLBACK_SET',
      ],
      [
        'MAKER_IPC_INVOKE.SESSION_RUNTIME_FALLBACK_SET',
        'MAKER_IPC_INVOKE.SESSION_RUNTIME_FALLBACK_RESET',
      ],
      ['MAKER_IPC_INVOKE.SESSION_RUNTIME_FALLBACK_RESET', 'MAKER_IPC_INVOKE.COMPACTION_GET_PCT'],
      ['MAKER_IPC_INVOKE.COMPACTION_GET_PCT', 'MAKER_IPC_INVOKE.COMPACTION_GET_STATE'],
      ['MAKER_IPC_INVOKE.COMPACTION_GET_STATE', 'MAKER_IPC_INVOKE.COMPACTION_RESET_PCT'],
      ['MAKER_IPC_INVOKE.COMPACTION_RESET_PCT', 'MAKER_IPC_INVOKE.COMPACTION_SET_PCT'],
      ['MAKER_IPC_INVOKE.COMPACTION_SET_PCT', 'MAKER_IPC_INVOKE.PI_COMPACTION_GET_PCT'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_GET_PCT', 'MAKER_IPC_INVOKE.PI_COMPACTION_GET_STATE'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_GET_STATE', 'MAKER_IPC_INVOKE.PI_COMPACTION_RESET_PCT'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_RESET_PCT', 'MAKER_IPC_INVOKE.PI_COMPACTION_SET_PCT'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_SET_PCT', 'WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL'],
    ] as const) {
      const body = handlerBody(bootstrapSource, channel, nextChannel);
      const guard = body.indexOf('assertTrustedAppRendererEvent(event);');
      expect(guard).toBeGreaterThan(-1);
      const storeAccess = Math.min(
        ...[
          'sessionRuntimeFallbackWire()',
          'writeSessionRuntimeFallbackEnabled(',
          'resetSessionRuntimeFallbackSettings()',
          'writeCompactionPct(',
          'resetCompactionPct()',
          'writePiCompactionPct(',
          'resetPiCompactionPct()',
          'compactionWire()',
          'piCompactionWire()',
          'readCompactionPct()',
          'readPiCompactionPct()',
        ]
          .map((needle) => body.indexOf(needle))
          .filter((index) => index >= 0),
      );
      expect(guard).toBeLessThan(storeAccess);
    }
  });

  it('binds compaction writes to the initiating owner stamp', () => {
    for (const [channel, nextChannel] of [
      ['MAKER_IPC_INVOKE.COMPACTION_RESET_PCT', 'MAKER_IPC_INVOKE.COMPACTION_SET_PCT'],
      ['MAKER_IPC_INVOKE.COMPACTION_SET_PCT', 'MAKER_IPC_INVOKE.PI_COMPACTION_GET_PCT'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_RESET_PCT', 'MAKER_IPC_INVOKE.PI_COMPACTION_SET_PCT'],
      ['MAKER_IPC_INVOKE.PI_COMPACTION_SET_PCT', 'WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL'],
    ] as const) {
      const body = handlerBody(bootstrapSource, channel, nextChannel);
      const stamp = body.indexOf('assertCompactionMutationOwner(owner);');
      expect(stamp).toBeGreaterThan(-1);
      const write = Math.min(
        ...['writeCompactionPct(', 'resetCompactionPct()', 'writePiCompactionPct(', 'resetPiCompactionPct()']
          .map((needle) => body.indexOf(needle))
          .filter((index) => index >= 0),
      );
      expect(stamp).toBeLessThan(write);
    }
  });

  it('clears runtime overrides synchronously at the owner commit boundary', () => {
    const body = handlerBody(
      bootstrapSource,
      'setAppSessionCommitBoundaryHook(() => {',
      '// ── Custom protocol registration',
    );
    expect(body).toContain('ghostPanelWindowsController.closeForOwnerChange();');
    expect(body).toContain('clearAllSessionProviders();');
    expect(body).toContain('clearAllSessionRuntimeAxes();');
    expect(body.indexOf('clearAllSessionProviders();')).toBeLessThan(
      body.indexOf('clearAllSessionRuntimeControlStates();'),
    );
    expect(body.indexOf('clearAllSessionRuntimeAxes();')).toBeLessThan(
      body.indexOf('clearAllSessionRuntimeControlStates();'),
    );
    expect(body.indexOf('clearAllSessionRuntimeControlStates();')).toBeLessThan(
      body.indexOf('authManager.setStableOwnerPostCommitTask('),
    );
    expect(registerSource).toContain('effort: resolveRetainedRuntimeEffort({');
    expect(registerSource).toContain('targetModelHasFixedEffort,');
    expect(registerSource).toContain(
      'fastMode: retainedSession.getFastMode() ?? previousRuntime.fastMode',
    );
  });

  it('serializes user effort and Fast mutations with model route changes', () => {
    const effort = handlerBody(
      registerSource,
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
      'MAKER_INVOKE.SET_PERMISSION_MODE',
    );
    const fast = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_FAST_MODE',
      'MAKER_INVOKE.SET_THINKING_ENABLED',
    );
    for (const [body, applyCall] of [
      [effort, 'return await applyEffort();'],
      [fast, 'return await applyFastMode();'],
    ] as const) {
      expect(body).toContain('withSendToSessionLock(sessionId');
      expect(body.indexOf('withSendToSessionLock(sessionId')).toBeLessThan(
        body.indexOf(applyCall),
      );
      expect(body).toContain('await resolvePendingRuntimeAxisPatch(sessionId, livePatch)');
      expect(body).toContain(
        'recordUserSessionRuntimeAxisMutation(sessionId, livePatch, pendingPatch)',
      );
    }
  });

  it('serializes local and remote directory validation, runtime apply, persistence, and rollback', () => {
    const grantUpdate = handlerBody(
      registerSource,
      'const applyDirectoryGrants =',
      'ipcMain.handle(MAKER_INVOKE.SET_EXTRA_DIRS',
    );
    const extraDirs = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_EXTRA_DIRS',
      'MAKER_INVOKE.SET_WRITABLE_DIRS',
    );
    const writableDirs = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_WRITABLE_DIRS',
      '// ── Memory 控制',
    );

    expect(grantUpdate).toContain('withSendToSessionLock(sessionId');
    expect(grantUpdate).toContain('applyRemoteDirectoryGrantUpdate(axis');
    expect(grantUpdate).toContain('persist: (patch) => persistSessionFields(sessionId, patch)');
    expect(grantUpdate).toContain('terminate: () => maker.closeSession(sessionId)');
    expect(grantUpdate).toContain('markRemoteSettingPersistedInsideHandler(result.dirs)');
    expect(grantUpdate).toContain('options.remote || route?.remoteHostId');
    expect(grantUpdate).toContain('isPersistedDirectoryGrantSubset(accepted, previousDirs)');
    expect(extraDirs).toContain("applyDirectoryGrants('extraDirs'");
    expect(writableDirs).toContain("applyDirectoryGrants('writableDirs'");
    expect(writableDirs).toContain('senderId: event.sender.id');
  });

  it('guards local user model changes before parsing input while preserving trusted internal paths', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const guard = setModel.indexOf(
      "if (internalOptions.source === 'user' && !isDeviceLinkInvoke()) {",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(setModel.indexOf('assertTrustedAppRendererEvent(')).toBeGreaterThan(
      guard,
    );
    expect(setModel.indexOf('assertTrustedAppRendererEvent(')).toBeLessThan(
      setModel.indexOf("typeof sessionId !== 'string'"),
    );
    expect(setModel).toContain(
      '!isSupportedRuntimeEffort((selection as { effort?: unknown }).effort)',
    );
    expect(setModel).toContain("internalOptions.source !== 'user'");
    expect(registerSource).toMatch(
      /handleSetModel\(\s*undefined,\s*sessionId,\s*model,\s*providerId,\s*undefined,\s*selection,\s*options,?\s*\)/,
    );
    expect(setModel).toMatch(/\{\s*source:\s*'user',?\s*\}/);
    expect(setModel).not.toContain('ipcMain.handle(MAKER_INVOKE.SET_MODEL, handleSetModel)');
  });

  it('validates atomic user axes against the selected catalog model before side effects', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const axisValidation = setModel.indexOf('if (atomicSelection) {');
    expect(axisValidation).toBeGreaterThan(-1);
    expect(setModel).not.toContain(
      "if (internalOptions.source !== 'user' && atomicSelection)",
    );
    expect(setModel).toContain(
      "internalOptions.source === 'user' || internalOptions.effortExplicit === true",
    );
    expect(setModel).toContain(
      "internalOptions.source === 'user' || internalOptions.fastExplicit === true",
    );
    expect(setModel).toContain(
      "allowFixedEffortPlaceholder: internalOptions.source === 'user'",
    );
    expect(axisValidation).toBeLessThan(setModel.indexOf('applyRuntimeSetModelChange({'));
    expect(axisValidation).toBeLessThan(setModel.indexOf('persistSessionFields(sessionId'));
  });

  it('commits user effort and Fast state only after the live runtime call succeeds', () => {
    const effort = handlerBody(
      registerSource,
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
      'MAKER_INVOKE.SET_PERMISSION_MODE',
    );
    const fast = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_FAST_MODE',
      'MAKER_INVOKE.SET_THINKING_ENABLED',
    );

    expect(effort.lastIndexOf('commit: commitEffort')).toBeGreaterThan(
      effort.indexOf('await applyRuntimeEffortWithRecovery({'),
    );
    expect(fast.lastIndexOf('commit: commitFastMode')).toBeGreaterThan(
      fast.indexOf('await sess.setFastMode(enabled);'),
    );
    for (const [body, persist, commit] of [
      [effort, 'persist: persistEffort', 'commit: commitEffort'],
      [fast, 'persist: persistFastMode', 'commit: commitFastMode'],
    ] as const) {
      expect(body).toContain('commitRuntimeAxisAfterPersistence({');
      expect(body.indexOf(persist)).toBeLessThan(body.indexOf(commit));
      expect(body).toContain('markRemoteSettingPersistedInsideHandler(remoteResponse);');
      expect(body).toContain('recoverRemoteRuntimeAxisPersistence(');
      expect(body).toContain('assertCanCommit: assertOwnerCurrent');
    }
  });

  it('cancels and publishes a deferred runtime mutation after settlement fails', () => {
    const settlement = handlerBody(
      registerSource,
      'const settlePendingSessionRuntimeControl =',
      'settlePendingSessionRuntimeControlHolder = settlePendingSessionRuntimeControl;',
    );
    const catchBlock = settlement.slice(settlement.indexOf('} catch (error) {'));

    expect(catchBlock).toContain(
      'cancelPendingSessionRuntimeMutation(sessionId, pending.generation)',
    );
    expect(catchBlock).toContain('await broadcastSessionRuntimeProjection(sessionId)');
    expect(catchBlock.indexOf('cancelPendingSessionRuntimeMutation')).toBeLessThan(
      catchBlock.indexOf('broadcastSessionRuntimeProjection'),
    );
  });

  it('drops in-flight effort and Fast mutations after an owner boundary', () => {
    const effort = handlerBody(
      registerSource,
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
      'MAKER_INVOKE.SET_PERMISSION_MODE',
    );
    const fast = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_FAST_MODE',
      'MAKER_INVOKE.SET_THINKING_ENABLED',
    );

    for (const body of [effort, fast]) {
      expect(body).toContain('const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();');
      expect(body).toContain('sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)');
      expect(body).toContain('assertCanCommit: assertOwnerCurrent');
      expect(body.indexOf('assertOwnerCurrent();')).toBeLessThan(
        body.indexOf('return await apply'),
      );
    }
    expect(registerSource).toContain(
      'if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return;',
    );
  });

  it('rejects terminal tasks inside the shared route lock before runtime mutations', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const terminalGuard = setModel.indexOf("runtimeStatus.status !== 'active'");
    expect(terminalGuard).toBeGreaterThan(setModel.indexOf('const applyLocked = async () => {'));
    expect(terminalGuard).toBeLessThan(setModel.indexOf('acceptSessionRuntimeMutation({'));
    expect(terminalGuard).toBeLessThan(setModel.indexOf('applyRuntimeSetModelChange({'));
    expect(setModel).toContain('return withSendToSessionLock(sessionId, applyLocked);');
  });

  it('maps every Codex relink failure to the structured IPC error protocol', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const relinkBoundary = setModel.slice(
      setModel.indexOf('const relinkCodexThread ='),
      setModel.indexOf('const rebuildLiveOrcaWorker'),
    );
    expect(relinkBoundary).toContain(
      "throwIpcError(\n                'PRECONDITION_FAILED'",
    );
    expect(relinkBoundary).toContain('.catch((error) => {');
    expect(relinkBoundary).toContain('reserveCodexForkCleanup(');
    expect(relinkBoundary).toContain('...(cleanup ? { cleanup } : {})');
    expect(relinkBoundary).toContain('if (isIpcError(error)) throw error;');
    expect(relinkBoundary).toContain(
      "throwIpcError('INTERNAL', 'Failed to rebuild Codex provider thread')",
    );
    expect(relinkBoundary).not.toContain('throw new Error');
  });

  it('relinks legacy provider selections with the persisted effort and Fast axes', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const targetRoute = setModel.slice(
      setModel.indexOf('const targetCodexRoute:'),
      setModel.indexOf('const relinkCodexThread ='),
    );
    expect(targetRoute).toContain('requiresCodexThreadRelink');
    expect(targetRoute).toContain('? {');
    expect(targetRoute).toContain(
      'effort: atomicSelection ? atomicSelection.effort : runtimeStatus.effort',
    );
    expect(targetRoute).toContain(
      'fastMode: atomicSelection ? atomicSelection.fastMode : runtimeStatus.fastMode',
    );
    expect(targetRoute).not.toContain('requiresCodexThreadRelink && atomicSelection');
  });

  it('derives the Codex relink boundary from effective credential identities', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const relinkGate = setModel.slice(
      setModel.indexOf('const hasPersistedLocalCodexThread ='),
      setModel.indexOf('const targetCodexRoute:'),
    );
    expect(relinkGate).toContain('decideCodexProviderThreadRelink(');
    expect(relinkGate).toContain(
      '{ model: runtimeStatus.model, providerId: runtimeStatus.providerId }',
    );
    expect(relinkGate).toContain('{ model, providerId: targetProviderId }');
    expect(relinkGate).toContain("relinkDecision === 'unresolved'");
    expect(relinkGate).toContain("relinkDecision === 'relink'");
    expect(relinkGate).toContain("throwIpcError(\n          'PRECONDITION_FAILED'");
  });

  it('rejects terminal tasks before effort or Fast mutations recreate runtime state', () => {
    const effort = handlerBody(
      registerSource,
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
      'MAKER_INVOKE.SET_PERMISSION_MODE',
    );
    const fast = handlerBody(
      registerSource,
      'MAKER_INVOKE.SET_FAST_MODE',
      'MAKER_INVOKE.SET_THINKING_ENABLED',
    );
    for (const [body, commit] of [
      [effort, 'commit: commitEffort'],
      [fast, 'commit: commitFastMode'],
    ] as const) {
      const terminalGuard = body.indexOf("runtimeStatus.status !== 'active'");
      expect(terminalGuard).toBeGreaterThan(-1);
      expect(terminalGuard).toBeLessThan(body.indexOf(commit));
      expect(body.indexOf('.select({ status: sessions.status })')).toBeLessThan(terminalGuard);
      expect(body).toContain('return withSendToSessionLock(sessionId');
    }
  });

  it('retains runtime state across process closes and clears it at task lifecycle boundaries', () => {
    const closeBoundary = handlerBody(
      registerSource,
      "if (status === 'closed') {",
      'const closedDirectAbortBoundary',
    );
    const terminalCleanup = handlerBody(
      registerSource,
      'setSessionRuntimeCleanup((sessionId) => {',
      'disposePiPackagesChangedBroadcast?.();',
    );

    expect(closeBoundary).not.toContain('clearSessionRuntimeControlState(session.id);');
    expect(terminalCleanup).toContain('clearSessionRuntimeControlState(sessionId);');
    expect(terminalCleanup).toContain('clearSessionProvider(sessionId);');
    expect(terminalCleanup).toContain('setSessionEffort(sessionId, null);');
    expect(terminalCleanup).toContain('setSessionFastMode(sessionId, false);');
  });

  it('preserves the exact auto-resume attempt across a fallback route rebuild', () => {
    expect(registerSource).toContain(
      'const pendingSessionRuntimeFallbackRebuilds = new WeakMap<Session, number>();',
    );
    expect(registerSource).toContain(
      'pendingSessionRuntimeFallbackRebuilds.set(runtimeSession, attemptToken);',
    );
    expect(registerSource).toContain(
      'pendingSessionRuntimeFallbackRebuilds.delete(fallbackRebuildSession);',
    );
    expect(registerSource).toContain(
      'shouldPreserveSessionRuntimeFallbackAutoResume(session, closeReason)',
    );
    expect(registerSource).toContain('autoResumeBookkeeping.hasSchedule(session.id)');
    expect(registerSource).toContain(
      'decision.episodeAttempt,\n                decision.attemptToken,',
    );
    expect(registerSource).toContain('isRemoteModelSwitchRouteChangeError(error)');
    expect(registerSource).toContain(
      'automatic session runtime fallback rebuilding frozen remote route',
    );
    expect(registerSource).toContain(
      'await withRehydrateCloseSuppressed(sessionId, () => maker.closeSession(sessionId));',
    );
    expect(registerSource).toContain('result = await applyCandidate();');
  });

  it('fences atomic model axis settlement after an owner boundary', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    expect(setModel).toContain('const assertRuntimeOwnerCurrent = (): void => {');
    expect(setModel).toContain('assertCanCommit: assertRuntimeOwnerCurrent,');

    const retainedRecovery = handlerBody(
      setModel,
      'const reconcileRetainedLiveProfile = async (): Promise<void> => {',
      'try {\n        const result = routeExplicit',
    );
    const capabilityLookup = retainedRecovery.indexOf(
      'const retainedProviders = await getDesktopProviderService().listProviders({',
    );
    const postLookupOwnerFence = retainedRecovery.indexOf(
      'if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) {',
      capabilityLookup,
    );
    const firstRecoveredStoreWrite = retainedRecovery.indexOf(
      'setSessionProvider(sessionId, retainedProfile.providerId);',
    );
    expect(capabilityLookup).toBeGreaterThan(-1);
    expect(postLookupOwnerFence).toBeGreaterThan(capabilityLookup);
    expect(postLookupOwnerFence).toBeLessThan(firstRecoveredStoreWrite);
  });

  it('clears fixed-effort overrides from lazy bootstrap and the bridge effort store', () => {
    expect(registerSource).toContain('o.effort = runtimeOverride.effort ?? undefined;');
    expect(registerSource).toContain('setSessionEffort(session.id, runtimeOverride.effort);');
    expect(registerSource).toContain('setSessionEffort(sessionId, selectionToCommit.effort);');
  });

  it('keeps explicit provider null and fixed-effort null through runtime settlement', () => {
    expect(registerSource).toMatch(
      /effectiveProviderId === null\s*\? null\s*: \(normalizeSessionProviderId\(effectiveProviderId\) \?\? currentProviderId\)/,
    );
    expect(registerSource).toContain('effort: pending.profile.effort,');
    expect(registerSource).toContain('effort: candidate.effort, fastMode: candidate.fastMode');
    expect(registerSource).toContain('effort: next.effort, fastMode: next.fastMode');
  });

  it('projects runtime state into shared session snapshots and patch notifications', () => {
    expect(registerSource).toContain('setSessionRuntimeProjector((session) =>');
    expect(registerSource).toContain('setSessionRuntimeCleanup((sessionId) =>');
    expect(registerSource).toContain('broadcastSessionRuntimeProjection(sessionId');
    expect(registerSource).toContain('runtimeEffective: effective');
    expect(registerSource).toContain('runtimePending: control.pending');
    expect(registerSource).toContain("effort: effective.effort ?? '',");
  });

  it('counts fallback eligibility across the whole interrupted-turn episode', () => {
    expect(registerSource).toContain(
      'decision.episodeAttempt,\n                decision.attemptToken,',
    );
  });

  it('records failed fallback routes without allowing stale owner work to mutate state', () => {
    const fallback = handlerBody(
      registerSource,
      'const maybeApplySessionRuntimeFallback = async (',
      'const sessionControlService = createSessionControlService({',
    );
    expect(fallback).toContain(
      'const runtimeOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();',
    );
    expect(fallback).toContain(
      'if (!sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)) return;',
    );
    expect(fallback).toContain('await withSendToSessionLock(sessionId, async () => {');
    expect(fallback).toContain("if (runtimeStatus?.status !== 'active') return;");
    expect(fallback).toContain('recordFailedSessionRuntimeFallbackCandidate(');
    expect(fallback).toContain('profiles.control.generation,');
  });

  it('commits runtime control before best-effort context bookkeeping', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const runtimeCommit = setModel.indexOf('let generation: number;');
    const contextSnapshot = setModel.indexOf('await recordSessionContextSnapshot(');
    expect(runtimeCommit).toBeGreaterThan(-1);
    expect(contextSnapshot).toBeGreaterThan(runtimeCommit);
    expect(setModel.indexOf('recordUserSessionRuntimeMutation(sessionId)', runtimeCommit)).toBeLessThan(
      contextSnapshot,
    );
    expect(setModel.indexOf('settlePendingSessionRuntimeMutation(', runtimeCommit)).toBeLessThan(
      contextSnapshot,
    );
    expect(setModel.indexOf('acceptSessionRuntimeMutation({', runtimeCommit)).toBeLessThan(
      contextSnapshot,
    );
    expect(setModel.slice(runtimeCommit, contextSnapshot)).toContain('if (!response.deferred) {');
    expect(setModel.slice(runtimeCommit, contextSnapshot)).toContain('try {');
    expect(setModel).toContain('runtime model context snapshot refresh failed');
  });

  it('composes later partial runtime changes on the accepted pending profile', () => {
    expect(registerSource).toContain(
      'const routeExplicit = patch.model !== undefined || patch.providerId !== undefined;',
    );
    expect(registerSource).toContain(
      'const mergeBase = routeExplicit\n        ? (profiles.control.pending?.profile ?? profiles.effective)\n        : profiles.effective;',
    );
    expect(registerSource).toContain('mergeSessionRuntimeProfilePatch(mergeBase, patch)');
    expect(registerSource).toContain('routeExplicit,');
    expect(registerSource).toContain('effectiveProfile: profiles.effective,');
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    expect(setModel).toContain(
      'if (internalOptions.deferWhileRunning && isSessionInTurn(sessionId))',
    );
    expect(setModel).toContain('deferSessionRuntimeAxisMutation({');
    expect(setModel).toContain('pendingPatch: pendingAxisPatch');
    expect(registerSource).toContain('routeExplicit: isPendingSessionRuntimeRouteExplicit(');
    expect(setModel).toContain('const result = routeExplicit');
    expect(setModel).toContain('acceptSessionRuntimeAxisMutation({');
    expect(setModel).toContain('applyEffort: routeExplicit || internalOptions.effortExplicit === true');
    expect(setModel).toContain('applyFastMode: routeExplicit || internalOptions.fastExplicit === true');
  });

  it('rebuilds live Orca Workers for model routes while preserving effort-only hot updates', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    expect(setModel).toContain("runtimeStatus.orcaRole === 'worker'");
    expect(setModel).toContain('forceSessionRebuild: rebuildLiveOrcaWorker');
    expect(setModel).toContain('if (rebuildLiveOrcaWorker && !response.deferred)');
  });
});
