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
    ] as const) {
      const body = handlerBody(bootstrapSource, channel, nextChannel);
      const guard = body.indexOf('assertTrustedAppRendererEvent(event);');
      expect(guard).toBeGreaterThan(-1);
      const storeAccess = Math.min(
        ...[
          'sessionRuntimeFallbackWire()',
          'writeSessionRuntimeFallbackEnabled(',
          'resetSessionRuntimeFallbackSettings()',
        ]
          .map((needle) => body.indexOf(needle))
          .filter((index) => index >= 0),
      );
      expect(guard).toBeLessThan(storeAccess);
    }
  });

  it('clears runtime overrides synchronously at the owner commit boundary', () => {
    const body = handlerBody(
      bootstrapSource,
      'setAppSessionCommitBoundaryHook(() => {',
      '// ── Custom protocol registration',
    );
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
    expect(registerSource).toContain(
      'effort: retainedSession.getEffort() ?? previousRuntime.effort ?? null',
    );
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
    }
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

  it('composes later partial runtime changes on the accepted pending profile', () => {
    expect(registerSource).toContain(
      'const mergeBase = profiles.control.pending?.profile ?? profiles.effective;',
    );
    expect(registerSource).toContain('mergeSessionRuntimeProfilePatch(mergeBase, patch)');
  });
});
