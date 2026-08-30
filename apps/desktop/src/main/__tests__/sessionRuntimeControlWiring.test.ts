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
const deviceLinkHostSource = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8').replace(
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
    expect(setModel).toContain('!isSupportedRuntimeEffort(selectionEffort)');
    expect(setModel).toContain("internalOptions.source !== 'user'");
    expect(registerSource).toMatch(
      /handleSetModel\(\s*undefined,\s*sessionId,\s*model,\s*providerId,\s*undefined,\s*selection,\s*options,?\s*\)/,
    );
    expect(setModel).toMatch(/\{\s*source:\s*'user',?\s*\}/);
    expect(setModel).not.toContain('ipcMain.handle(MAKER_INVOKE.SET_MODEL, handleSetModel)');
  });

  it('accepts null effort only for fixed-effort local confirmation retries before rebuild', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const confirmation = setModel.indexOf('const confirmedContextWindow =');
    const selectionValidation = setModel.indexOf('!isSupportedRuntimeEffort(selectionEffort)');
    const fixedEffortValidation = setModel.indexOf('atomicSelection.effort === null');
    const prepare = setModel.indexOf('prepareModelWindowSwitch(');
    const apply = setModel.indexOf('applyRuntimeSetModelChange({');

    expect(confirmation).toBeGreaterThan(-1);
    expect(confirmation).toBeLessThan(selectionValidation);
    expect(setModel).toContain(
      "selectionEffort === null &&\n            (internalOptions.source !== 'user' || confirmedContextWindow !== undefined)",
    );
    expect(setModel).toContain('catalogModel.efforts.length > 0');
    expect(fixedEffortValidation).toBeGreaterThan(selectionValidation);
    expect(fixedEffortValidation).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(apply);
    expect(setModel).toContain(
      '!isDeviceLinkInvoke() && confirmedContextWindow === targetContextWindow',
    );
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

  it('requires a verified target window before preparing any destructive model rebuild', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const verifiedWindowOnly = setModel.indexOf(
      'targetContextWindow = verifiedTargetWindow ?? undefined;',
    );
    const unknownWindowGuard = setModel.indexOf(
      'target model context window is unknown; runtime selection was not changed',
    );
    const prepare = setModel.indexOf('prepareModelWindowSwitch(');
    const apply = setModel.indexOf('applyRuntimeSetModelChange({');
    expect(verifiedWindowOnly).toBeGreaterThan(-1);
    expect(setModel).toContain('await maker.getSessionMeta(sessionId)');
    expect(setModel).toContain(
      'liveSessionBeforeRouteChange?.model ?? persistedSessionMeta?.model',
    );
    expect(setModel).not.toContain(
      'if (liveSessionBeforeRouteChange && runtimeAgentKind && runtimeRouteChanged)',
    );
    expect(setModel).not.toContain('verifiedTargetWindow ?? targetCatalogModel?.contextWindow');
    expect(verifiedWindowOnly).toBeLessThan(unknownWindowGuard);
    expect(unknownWindowGuard).toBeLessThan(prepare);
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(apply);
    expect(setModel).not.toContain('getAutoCompactThresholdPct');
    expect(setModel).toContain("preparation === 'busy'");
    expect(setModel).toContain("preparation === 'remote-unsupported'");
    expect(setModel).toContain('beforeClose: () => {');
    expect(setModel).toContain('clearPendingCredentialSwitchForSession(sessionId, { wake: false })');
    expect(setModel).toContain('sessionRuntimeControlOwnerEpochMatches(runtimeOwnerEpoch)');
    expect(setModel).toContain('modelWindowRebuilt ||');
    expect(setModel).toContain('patch.contextWindow = targetContextWindow;');
    expect(setModel).toContain('(rebuildLiveOrcaWorker || modelWindowRebuilt)');
    expect(setModel).toContain('wakeSessionInputAfterCredentialSwitch(sessionId);');
  });

  it('projects rebuilt zero usage and the verified window after the runtime is closed', () => {
    const commitRebuild = handlerBody(
      registerSource,
      'commitRebuild: async (sessionId, handoff, meta) => {',
      'setPendingHandoff: (sessionId, handoff, expectedGeneration)',
    );
    const query = commitRebuild.indexOf('contextWindow: sessions.contextWindow,');
    const commit = commitRebuild.indexOf('commitContextRebuild(sessionId, handoff, meta)');
    const broadcast = commitRebuild.indexOf('broadcastSessionPatched(\n        sessionId,');

    expect(query).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(query);
    expect(broadcast).toBeGreaterThan(commit);
    expect(commitRebuild).toContain('contextTokens: 0,');
    expect(commitRebuild).toContain('{ contextWindow: projectionContextWindow }');
    expect(commitRebuild).toContain('const ownerScope = captureDataOwnerBroadcastScope();');
    expect(commitRebuild).toContain('getCurrentDbClientSnapshot()?.clientEpoch');
    expect(commitRebuild).toContain('ownerScope,\n      );');
    expect(commitRebuild).toContain("log.warn('context rebuild card creation failed after commit'");
    expect(commitRebuild).toContain('try {\n        await createDbMessage(\n          sessionId,');

    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    expect(setModel).toContain("typeof runtimeStatus.contextTokens === 'number'");
    expect(setModel).toContain('runtimeStatus.contextTokens >= 0');
    const persistFinalRoute = setModel.indexOf('await persistSessionFields(sessionId, patch);');
    const projectFinalWindow = setModel.indexOf(
      '// commitRebuild first projects zero usage against the still-authoritative',
    );
    expect(persistFinalRoute).toBeGreaterThan(-1);
    expect(projectFinalWindow).toBeGreaterThan(persistFinalRoute);
    expect(setModel.slice(projectFinalWindow)).toContain('contextTokens: 0,');
    expect(setModel.slice(projectFinalWindow)).toContain('contextWindow: targetContextWindow,');
    expect(setModel).toContain(
      'const routeProjectionOwnerScope = captureDataOwnerBroadcastScope();',
    );
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
    expect(catchBlock).toContain("const failureReason = 'runtime-selection-cancelled'");
    expect(catchBlock).toContain('onTurnErrorEvent(sessionId, { message: failureMessage');
    expect(catchBlock).toContain('broadcastToAllWindows(MAKER_PUSH.EVENT');
    expect(catchBlock).toContain('The previous model remains active.');
    expect(catchBlock.indexOf('broadcastSessionRuntimeProjection')).toBeLessThan(
      catchBlock.indexOf('broadcastToAllWindows(MAKER_PUSH.EVENT'),
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

  it('skips stale Codex thread relink after rebuild and still commits the target route', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const rebuilt = setModel.indexOf("modelWindowRebuilt = preparation === 'rebuilt'");
    const relinkGate = setModel.indexOf(
      'const shouldRelinkCodexThread = requiresCodexThreadRelink && !modelWindowRebuilt;',
    );
    const apply = setModel.indexOf('await applyRuntimeSetModelChange({');
    const persist = setModel.indexOf('await persistSessionFields(sessionId, patch);');

    expect(rebuilt).toBeGreaterThan(-1);
    expect(relinkGate).toBeGreaterThan(rebuilt);
    expect(relinkGate).toBeLessThan(apply);
    expect(setModel.slice(apply, persist)).toContain(
      'requiresCodexThreadRelink: shouldRelinkCodexThread',
    );
    expect(setModel.slice(apply, persist)).toContain(
      'shouldRelinkCodexThread && relinkCodexThread',
    );
    expect(setModel.slice(apply, persist)).toContain(
      'result.persistedRoute !== true &&\n          (modelWindowRebuilt ||',
    );
    expect(persist).toBeGreaterThan(apply);
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

  it('persists Pi runtime-verified windows without catalog replacement', () => {
    const snapshotStart = registerSource.indexOf('if (pendingContextSnapshot) {');
    const snapshotEnd = registerSource.indexOf(
      'if (pendingCodexAccountUsageSnapshot)',
      snapshotStart,
    );
    const snapshot = registerSource.slice(snapshotStart, snapshotEnd);

    expect(snapshot).toContain("session.agentKind === 'pi'");
    expect(snapshot).toContain('piRuntimeWindow ?? verifiedWindow');
    expect(snapshot.indexOf('pendingContextSnapshot.contextWindow')).toBeLessThan(
      snapshot.indexOf('lookupVerifiedContextWindow('),
    );
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

  it('rehydrates a cold Pi runtime before model-window assessment', () => {
    const rehydrate = handlerBody(
      registerSource,
      'async function rehydrateColdPiRuntimeForWindowVerification(',
      'const agentSwitchDeps:',
    );
    const rolloverWiring = handlerBody(
      registerSource,
      'contextOverflowRolloverHolder = createContextOverflowRollover({',
      'registerMakerSessionSendHandler(makerSessionRegistry,',
    );

    expect(rehydrate).toContain("row.agentKind !== 'pi'");
    expect(rehydrate).toContain('resumeSessionId: row.sdkSessionId');
    expect(rehydrate).toContain('await bootstrapSession(createOpts)');
    expect(rehydrate).not.toContain('.send(');
    expect(rolloverWiring).toContain('rehydrateColdPiRuntimeForWindowVerification,');

    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const rehydrateCall = setModel.indexOf(
      'await rehydrateColdPiRuntimeForWindowVerification(sessionId)',
    );
    const apply = setModel.indexOf('await applyRuntimeSetModelChange({');
    expect(rehydrateCall).toBeGreaterThan(-1);
    expect(rehydrateCall).toBeLessThan(apply);
    expect(setModel).toContain('Pi current runtime could not be verified');
  });

  it('fails closed for non-Pi remote danger, overflow, and confirmation payloads', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );

    expect(setModel).not.toContain('CONTROLLER_CAPABILITY_MODEL_WINDOW_CONFIRMATION_V1');
    expect(deviceLinkHostSource).not.toContain(
      'CONTROLLER_CAPABILITY_MODEL_WINDOW_CONFIRMATION_V1',
    );
    expect(setModel).toContain("remoteTargetAssessment.level === 'danger'");
    expect(setModel).toContain("remoteTargetAssessment.level === 'overflow'");
    const remoteAssessment = setModel.indexOf('const remoteTargetAssessment');
    const remotePressureRejection = setModel.indexOf(
      'remote model-window rebuild is unsupported; runtime selection was not changed',
    );
    const nonPiRemoteGuard = setModel.indexOf("runtimeAgentKind !== 'pi'", remoteAssessment);
    expect(nonPiRemoteGuard).toBeGreaterThan(remoteAssessment);
    expect(nonPiRemoteGuard).toBeLessThan(remotePressureRejection);
    expect(setModel).toContain(
      'remote model-window rebuild is unsupported; runtime selection was not changed',
    );
    expect(setModel).toContain(
      'remote model-window confirmation is unsupported; runtime selection was not changed',
    );
    expect(setModel).toContain('!isDeviceLinkInvoke() && confirmedContextWindow ===');
    expect(setModel).toContain(
      "runtimeAgentKind !== 'pi' &&\n          confirmedContextWindow !== targetContextWindow",
    );
    expect(setModel).not.toContain('confirmedContextWindow > targetContextWindow');
  });

  it('fails closed before switching a busy or unverifiable cold remote Pi runtime', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const apply = setModel.indexOf('await applyRuntimeSetModelChange({');

    expect(setModel.indexOf('busy Pi task cannot change runtime selection')).toBeLessThan(apply);
    expect(
      setModel.indexOf('cold remote Pi runtime cannot verify the target window'),
    ).toBeLessThan(apply);
    expect(setModel).toContain('model window switch context is unknown; runtime selection was not changed');
    expect(setModel).toContain('finalPiWindow < verifiedCurrentWindow!');
    expect(setModel).not.toContain('finalPiWindow < targetContextWindow');
  });

  it('switches and verifies Pi before deciding whether the actual window needs rebuild', () => {
    const setModel = handlerBody(
      registerSource,
      'const handleSetModel = async (',
      'const recoverRemoteRuntimeAxisPersistence',
    );
    const apply = setModel.indexOf('await applyRuntimeSetModelChange({');
    const closeRecovery = setModel.indexOf('const closeRejectedPiRuntime =');
    const finalWindow = setModel.indexOf('const finalPiWindow =');
    const finalWindowEnd = setModel.indexOf('if (atomicSelection) {', finalWindow);
    const runtimeCommit = setModel.indexOf('let generation: number;');
    const finalPreparation = setModel.indexOf('let finalPreparation:');
    const smallerFinalWindow = setModel.indexOf('finalPiWindow < verifiedCurrentWindow!');
    const preflightPreparation = setModel.indexOf(
      'preparation = await contextOverflowRolloverHolder.prepareModelWindowSwitch(',
    );

    const piPreflightGuard = setModel.lastIndexOf(
      "runtimeAgentKind !== 'pi'",
      preflightPreparation,
    );
    expect(piPreflightGuard).toBeGreaterThan(-1);
    expect(preflightPreparation - piPreflightGuard).toBeLessThan(700);
    expect(closeRecovery).toBeGreaterThan(-1);
    expect(closeRecovery).toBeLessThan(finalWindow);
    expect(finalWindow).toBeGreaterThan(apply);
    expect(finalWindow).toBeLessThan(runtimeCommit);
    expect(setModel.match(/await closeRejectedPiRuntime\(/g)).toHaveLength(5);
    expect(finalWindowEnd).toBeGreaterThan(finalWindow);
    expect(setModel.slice(finalWindow, finalWindowEnd)).not.toContain(
      'await withRehydrateCloseSuppressed',
    );
    expect(setModel).toContain('restoreControlStores,');
    expect(setModel).toContain('failed to close Pi after rejected final-window selection');
    expect(setModel).toContain('recheckTargetPressure: true');
    expect(setModel).toContain("finalPreparation === 'confirmation-required'");
    expect(setModel).toContain('contextWindowConfirmationRequired: finalPiWindow');
    expect(setModel).toContain('contextTokensForConfirmation: finalPressureContextTokens');
    expect(setModel).toContain('finalPressureContextTokens = contextTokens');
    expect(setModel).toContain('runtimeRouteChanged || confirmedContextWindow !== undefined');
    expect(setModel).toContain('targetContextWindow = finalPiWindow');
    expect(setModel).toContain("if (!isDeviceLinkInvoke() && runtimeAgentKind === 'pi') {");
    expect(setModel).toContain("runtimeAgentKind !== 'pi' || !!runtimeStatus.remoteHostId");
    expect(setModel).not.toContain(
      "runtimeAgentKind !== 'pi' || isDeviceLinkInvoke() || !!runtimeStatus.remoteHostId",
    );
    const finalRemotePressureRejection = setModel.indexOf(
      'remote model-window confirmation is unsupported; runtime selection was not changed',
      finalWindow,
    );
    expect(finalRemotePressureRejection).toBeGreaterThan(finalWindow);
    expect(setModel).toContain('targetContextWindow = confirmedContextWindow ?? targetContextWindow');
    expect(setModel).toContain('confirmedContextWindow === targetContextWindow');
    expect(setModel).toContain('confirmedContextWindow === finalPiWindow');
    expect(finalPreparation).toBeGreaterThan(smallerFinalWindow);
    expect(setModel).toContain("finalPreparation === 'rebuilt'");
    expect(setModel).toContain("finalPreparation === 'remote-unsupported'");
    expect(setModel).toContain(
      "? 'remote model-window rebuild is unsupported; runtime selection was not changed'",
    );
    expect(setModel).toContain('`Pi final-window context preparation failed: ${finalPreparation}`');
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
    expect(setModel).toContain("currentAgentKind === 'pi'");
    expect(setModel).toContain('getUsageSnapshot?.().contextWindow');
    expect(setModel).toContain(': verifiedWindow;');
    expect(setModel).toContain('runtime model context snapshot refresh failed');
  });

  it('cancels deferred selection when final-window pressure would need confirmation', () => {
    const settle = handlerBody(
      registerSource,
      'const settlePendingSessionRuntimeControl =',
      'settlePendingSessionRuntimeControlHolder = settlePendingSessionRuntimeControl;',
    );

    expect(settle).toContain('if (!pending) return;');
    expect(settle).toContain('deferred model-window selection requires unsupported confirmation');
    expect(settle).toContain('cancelPendingSessionRuntimeMutation(sessionId, pending.generation)');
    expect(settle).toContain('await broadcastSessionRuntimeProjection(sessionId)');
    expect(settle).not.toContain('markPendingSessionRuntimeConfirmationRequired(');
    expect(settle).not.toContain('confirmedContextWindow: pending.confirmedContextWindow');
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
    expect(setModel).toContain(
      'if ((rebuildLiveOrcaWorker || modelWindowRebuilt) && !response.deferred)',
    );
  });
});
