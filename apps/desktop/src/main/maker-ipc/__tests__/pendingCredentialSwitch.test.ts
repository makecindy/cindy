import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import {
  getSessionEffort,
  getSessionFastMode,
  setSessionEffort,
  setSessionFastMode,
} from '../../maker-host/session-effort-store.js';
import {
  PendingCredentialSwitchService,
  type PendingCredentialSwitchDeps,
} from '../pendingCredentialSwitch.js';

const touchedSessions = new Set<string>();

afterEach(() => {
  for (const sessionId of touchedSessions) {
    clearSessionProvider(sessionId);
    setSessionEffort(sessionId, null);
    setSessionFastMode(sessionId, false);
  }
  touchedSessions.clear();
});

function rememberSession(sessionId: string): string {
  touchedSessions.add(sessionId);
  return sessionId;
}

interface HarnessSession {
  id: string;
  agentKind: 'claude-code' | 'codex';
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

function createHarness(
  sessions: HarnessSession[],
  opts?: {
    retryDelayMs?: number;
    resolveRoute?: PendingCredentialSwitchDeps['resolveRoute'];
    isOwnerScopeCurrent?: PendingCredentialSwitchDeps['isOwnerScopeCurrent'];
  },
) {
  const closeSession = vi.fn(async (_sessionId: string) => {});
  const broadcastApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['broadcastApplied']>>();
  const onApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['onApplied']>>();
  const onCancellationCompensated =
    vi.fn<NonNullable<PendingCredentialSwitchDeps['onCancellationCompensated']>>();
  const persistRoute = vi.fn<NonNullable<PendingCredentialSwitchDeps['persistRoute']>>(
    async () => {},
  );
  const relinkCodexThreadForProviderSwitch = vi.fn<
    NonNullable<PendingCredentialSwitchDeps['relinkCodexThreadForProviderSwitch']>
  >(async () => null);
  const service = new PendingCredentialSwitchService({
    maker: {
      listActiveSessions: () => sessions,
      closeSession,
    },
    broadcastApplied,
    onApplied,
    onCancellationCompensated,
    persistRoute,
    relinkCodexThreadForProviderSwitch,
    ...(opts?.isOwnerScopeCurrent
      ? { isOwnerScopeCurrent: opts.isOwnerScopeCurrent }
      : {}),
    ...(opts?.resolveRoute ? { resolveRoute: opts.resolveRoute } : {}),
    ...(opts?.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
  });
  return {
    service,
    closeSession,
    broadcastApplied,
    onApplied,
    onCancellationCompensated,
    persistRoute,
    relinkCodexThreadForProviderSwitch,
    sessions,
  };
}

describe('PendingCredentialSwitchService', () => {
  it('keeps the pending switch while the session is still running', async () => {
    const sessionId = rememberSession('pending-switch-still-busy');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('applies the switch at turn end: closes the session, writes the route, notifies', async () => {
    const sessionId = rememberSession('pending-switch-apply');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(h.closeSession).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'xd',
    });
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('relinks a deferred Codex thread before route persistence and queue wake', async () => {
    const sessionId = rememberSession('pending-switch-relink-codex-thread');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback: vi.fn(async () => true),
    });

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    // A crash before settlement cannot have persisted the target route. The production
    // registration bridge has already restored SQLite to previousRoute at this point.
    expect(h.persistRoute).not.toHaveBeenCalled();
    await h.service.onTurnSettled(sessionId);

    expect(h.closeSession).toHaveBeenCalledWith(sessionId);
    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledWith({
      sessionId,
      sourceModel: 'codex/gpt-5.6-sol',
      sourceProviderId: 'xd',
      targetModel: 'gpt-5.6-sol',
      targetProviderId: 'openai',
      isCurrent: expect.any(Function),
    });
    expect(h.relinkCodexThreadForProviderSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      h.onApplied.mock.invocationCallOrder[0]!,
    );
    expect(h.persistRoute).toHaveBeenCalledTimes(1);
    expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    });
    expect(h.persistRoute.mock.invocationCallOrder[0]).toBeLessThan(
      h.onApplied.mock.invocationCallOrder[0]!,
    );
  });

  it('recomputes relink from the final route when revalidation crosses thread families', async () => {
    const sessionId = rememberSession('pending-switch-reroute-crosses-thread-family');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async () => ({
          model: 'gpt-5.6-sol',
          providerId: 'openai',
          degraded: true,
        }),
      },
    );

    h.service.register(sessionId, {
      model: 'xai/grok-4.3',
      providerId: 'xai',
      agentKind: 'codex',
      sourceCodexThreadModelProviderId: 'cindy_gateway',
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledWith({
      sessionId,
      sourceModel: 'codex/gpt-5.6-sol',
      sourceProviderId: 'xd',
      sourceThreadModelProviderId: 'cindy_gateway',
      targetModel: 'gpt-5.6-sol',
      targetProviderId: 'openai',
      isCurrent: expect.any(Function),
    });
    expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
    });
  });

  it('skips a stale relink marker when revalidation returns to the source thread family', async () => {
    const sessionId = rememberSession('pending-switch-reroute-returns-to-source-family');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async () => ({
          model: 'codex/gpt-5.6-sol',
          providerId: 'xd',
          degraded: true,
        }),
      },
    );

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      agentKind: 'codex',
      sourceCodexThreadModelProviderId: 'cindy_gateway',
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.relinkCodexThreadForProviderSwitch).not.toHaveBeenCalled();
    expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
    });
  });

  it('keeps a deferred switch gated when the Codex thread relink fails', async () => {
    const sessionId = rememberSession('pending-switch-relink-failed');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.relinkCodexThreadForProviderSwitch.mockRejectedValueOnce(new Error('fork failed'));

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.persistRoute).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
    h.service.clear(sessionId);
  });

  it('discards an old-owner relink target during teardown and never retries it after recovery', async () => {
    const sessionId = rememberSession('pending-switch-owner-teardown');
    setSessionProvider(sessionId, 'xd');
    let currentOwner = { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' };
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        retryDelayMs: 10,
        isOwnerScopeCurrent: (scope) =>
          scope.ownerScopeKey === currentOwner.ownerScopeKey &&
          scope.runtimeOwnerEpoch === currentOwner.runtimeOwnerEpoch,
      },
    );
    const rollback = vi.fn(async () => {
      throw new Error('old profile teardown closed the client');
    });
    h.relinkCodexThreadForProviderSwitch.mockImplementationOnce(async (input) => {
      currentOwner = { ownerScopeKey: 'owner-boundary', runtimeOwnerEpoch: '7' };
      expect(input.isCurrent()).toBe(false);
      return {
        previousSdkSessionId: 'thread-xd',
        newSdkSessionId: 'thread-openai',
        rollback,
      };
    });

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      ownerScope: { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' },
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
    currentOwner = { ownerScopeKey: 'owner-a:2', runtimeOwnerEpoch: '8' };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledOnce();
    expect(h.persistRoute).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('restores the captured old Profile before completing an owner-stale discard', async () => {
    const sessionId = rememberSession('pending-switch-owner-route-restore');
    let currentOwner = { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' };
    let persistedProfile = {
      sdkSessionId: 'thread-xd',
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    };
    const restoreStaleOwnerRoute = vi.fn(async () => {
      if (
        persistedProfile.sdkSessionId !== 'thread-xd' ||
        persistedProfile.model !== 'gpt-5.6-sol' ||
        persistedProfile.providerId !== 'openai'
      ) {
        return false;
      }
      persistedProfile = {
        sdkSessionId: 'thread-xd',
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      };
      return true;
    });
    const h = createHarness([], {
      retryDelayMs: 10,
      isOwnerScopeCurrent: (scope) =>
        scope.ownerScopeKey === currentOwner.ownerScopeKey &&
        scope.runtimeOwnerEpoch === currentOwner.runtimeOwnerEpoch,
    });

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      ownerScope: { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' },
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });

    currentOwner = { ownerScopeKey: 'owner-boundary', runtimeOwnerEpoch: '7' };
    expect(h.service.has(sessionId)).toBe(true);
    expect(h.service.get(sessionId)).toBeUndefined();
    await vi.waitFor(() => expect(restoreStaleOwnerRoute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.service.has(sessionId)).toBe(false));

    currentOwner = { ownerScopeKey: 'owner-a:2', runtimeOwnerEpoch: '8' };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
    expect(h.service.get(sessionId)).toBeUndefined();
    expect(h.persistRoute).not.toHaveBeenCalled();
  });

  it('compensates a failed-fork target rejected across an owner boundary before returning', async () => {
    const sessionId = rememberSession('pending-switch-registration-owner-stale');
    let persistedProfile = {
      sdkSessionId: 'thread-xd',
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    };
    const restoreStaleOwnerRoute = vi.fn(async () => {
      persistedProfile = {
        sdkSessionId: 'thread-xd',
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      };
      return true;
    });
    const h = createHarness([], {
      isOwnerScopeCurrent: () => false,
    });

    const registered = await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      codexThreadRelinkCommitted: true,
      ownerScope: { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' },
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });

    expect(registered).toBe(false);
    expect(restoreStaleOwnerRoute).toHaveBeenCalledOnce();
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
    expect(h.service.get(sessionId)).toBeUndefined();
    expect(h.persistRoute).not.toHaveBeenCalled();
  });

  it('does not let a stale restored target erase the new owner pending for the same session id', () => {
    const sessionId = rememberSession('pending-switch-owner-reused-session-id');
    const currentOwner = { ownerScopeKey: 'owner-b:2', runtimeOwnerEpoch: '8' };
    const h = createHarness([], {
      retryDelayMs: 60_000,
      isOwnerScopeCurrent: (scope) =>
        scope.ownerScopeKey === currentOwner.ownerScopeKey &&
        scope.runtimeOwnerEpoch === currentOwner.runtimeOwnerEpoch,
    });

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      ownerScope: currentOwner,
    });
    h.service.register(sessionId, {
      model: 'deepseek/deepseek-v4-pro',
      providerId: 'deepseek',
      ownerScope: { ownerScopeKey: 'owner-a:1', runtimeOwnerEpoch: '7' },
    });

    expect(h.service.get(sessionId)).toMatchObject({
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      ownerScope: currentOwner,
    });
    h.service.clear(sessionId);
  });

  it('rolls back the relink when deferred route persistence fails', async () => {
    const sessionId = rememberSession('pending-switch-persist-rollback');
    setSessionProvider(sessionId, 'xd');
    const rollback = vi.fn(async () => true);
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async (_agent, model, providerId) => ({
          model,
          providerId,
          degraded: false,
        }),
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback,
    });
    h.persistRoute.mockRejectedValueOnce(new Error('sqlite failed'));

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(rollback).toHaveBeenCalledOnce();
    expect(h.service.get(sessionId)?.rebuildCodexThread).toBe(true);
    expect(h.onApplied).not.toHaveBeenCalled();
    h.service.clear(sessionId);
  });

  it('restores runtime axes before waking a cancellation whose route persistence failed', async () => {
    const sessionId = rememberSession('pending-switch-persist-failure-cancelled');
    setSessionProvider(sessionId, 'xd');
    setSessionEffort(sessionId, 'xhigh');
    setSessionFastMode(sessionId, true);
    const rollback = vi.fn(async () => true);
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async (_agent, model, providerId) => ({
          model,
          providerId,
          degraded: false,
        }),
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback,
    });
    h.persistRoute.mockImplementationOnce(async () => {
      h.service.clear(sessionId);
      throw new Error('sqlite failed');
    });

    await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
    });
    await h.service.onTurnSettled(sessionId);

    expect(rollback).toHaveBeenCalledOnce();
    expect(h.closeSession).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(getSessionEffort(sessionId)).toBe('high');
    expect(getSessionFastMode(sessionId)).toBe(false);
    expect(h.service.has(sessionId)).toBe(false);
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.onCancellationCompensated).toHaveBeenCalledOnce();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
  });

  it('restores a committed relink marker after cleanup so retry does not fork again', async () => {
    const sessionId = rememberSession('pending-switch-restore-committed-relink');
    setSessionProvider(sessionId, 'xd');
    const rollback = vi.fn(async () => {
      throw new Error('rollback failed');
    });
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async (_agent, model, providerId) => ({
          model,
          providerId,
          degraded: false,
        }),
        retryDelayMs: 60_000,
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback,
    });
    h.persistRoute.mockRejectedValueOnce(new Error('sqlite failed'));

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      agentKind: 'codex',
      sourceCodexThreadModelProviderId: 'cindy_gateway',
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(rollback).toHaveBeenCalledOnce();
    expect(h.service.get(sessionId)?.codexThreadRelinkCommitted).toBe(true);
    const recovered = h.service.get(sessionId)!;
    h.service.clear(sessionId);
    h.service.register(sessionId, recovered);

    await h.service.onTurnSettled(sessionId);

    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledOnce();
    expect(h.persistRoute).toHaveBeenCalledTimes(2);
    expect(h.service.has(sessionId)).toBe(false);
    expect(h.onApplied).toHaveBeenCalledOnce();
    expect(h.onCancellationCompensated).not.toHaveBeenCalled();
  });

  it('rolls back an abandoned relink when route persistence is superseded', async () => {
    const sessionId = rememberSession('pending-switch-superseded-after-persist');
    setSessionProvider(sessionId, 'xd');
    let persistedProfile = {
      sdkSessionId: 'thread-openai',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd' as string | null,
      effort: 'high',
      fastMode: false,
    };
    const rollback = vi.fn(async () => {
      if (persistedProfile.sdkSessionId !== 'thread-openai') return false;
      persistedProfile.sdkSessionId = 'thread-xd';
      return true;
    });
    const restoreStaleOwnerRoute = vi.fn(
      async (
        route?: { model: string; providerId: string | null; effort?: string; fastMode?: boolean },
        expectedSdkSessionId?: string,
      ) => {
        if (
          persistedProfile.sdkSessionId !== expectedSdkSessionId ||
          persistedProfile.model !== route?.model ||
          persistedProfile.providerId !== route?.providerId ||
          persistedProfile.effort !== route?.effort ||
          persistedProfile.fastMode !== route?.fastMode
        ) {
          return false;
        }
        persistedProfile = {
          sdkSessionId: 'thread-xd',
          model: 'codex/gpt-5.6-sol',
          providerId: 'xd',
          effort: 'high',
          fastMode: false,
        };
        return true;
      },
    );
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        resolveRoute: async (_agent, model, providerId) => ({
          model,
          providerId,
          degraded: false,
        }),
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback,
    });
    h.persistRoute.mockImplementationOnce(async (_persistedSessionId, route) => {
      persistedProfile = {
        ...persistedProfile,
        model: route.model ?? persistedProfile.model,
        providerId: route.providerId,
        effort: route.effort ?? persistedProfile.effort,
        fastMode: route.fastMode ?? persistedProfile.fastMode,
      };
      h.service.clear(sessionId, { wake: false });
      await h.service.register(sessionId, {
        model: 'gpt-5.6-sol',
        providerId: 'xd',
      });
    });

    await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });
    await h.service.onTurnSettled(sessionId);

    const abandonedRoute = {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    };
    expect(rollback).not.toHaveBeenCalled();
    expect(restoreStaleOwnerRoute).toHaveBeenCalledWith(abandonedRoute, 'thread-openai');
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledOnce();
    expect(h.service.get(sessionId)).toMatchObject({
      model: 'gpt-5.6-sol',
      providerId: 'xd',
    });
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.onCancellationCompensated).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    h.service.clear(sessionId);
  });

  it('keeps cancellation gated until a late persisted route is atomically compensated', async () => {
    const sessionId = rememberSession('pending-switch-cancel-during-persist');
    setSessionProvider(sessionId, 'xd');
    setSessionEffort(sessionId, 'xhigh');
    setSessionFastMode(sessionId, true);
    let persistedProfile = {
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd' as string | null,
      effort: 'high',
      fastMode: false,
    };
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      markPersistStarted = resolve;
    });
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const restoreStaleOwnerRoute = vi.fn(
      async (
        route?: { model: string; providerId: string | null; effort?: string; fastMode?: boolean },
        expectedSdkSessionId?: string,
      ) => {
        if (
          persistedProfile.sdkSessionId !== expectedSdkSessionId ||
          persistedProfile.model !== route?.model ||
          persistedProfile.providerId !== route?.providerId ||
          persistedProfile.effort !== route?.effort ||
          persistedProfile.fastMode !== route?.fastMode
        ) {
          return false;
        }
        persistedProfile = {
          sdkSessionId: 'thread-xd',
          model: 'codex/gpt-5.6-sol',
          providerId: 'xd',
          effort: 'high',
          fastMode: false,
        };
        return true;
      },
    );
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      { retryDelayMs: 60_000 },
    );
    h.relinkCodexThreadForProviderSwitch.mockImplementationOnce(async () => {
      persistedProfile.sdkSessionId = 'thread-openai';
      return {
        previousSdkSessionId: 'thread-xd',
        newSdkSessionId: 'thread-openai',
        rollback: vi.fn(async () => false),
      };
    });
    h.persistRoute.mockImplementationOnce(async (_persistedSessionId, route) => {
      markPersistStarted();
      await persistGate;
      persistedProfile = {
        ...persistedProfile,
        model: route.model ?? persistedProfile.model,
        providerId: route.providerId,
        effort: route.effort ?? persistedProfile.effort,
        fastMode: route.fastMode ?? persistedProfile.fastMode,
      };
    });

    await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });
    const settling = h.service.onTurnSettled(sessionId);
    await persistStarted;

    h.service.clear(sessionId);
    expect(h.service.has(sessionId)).toBe(true);
    expect(h.onApplied).not.toHaveBeenCalled();
    releasePersist();
    await settling;

    expect(restoreStaleOwnerRoute).toHaveBeenCalledWith(
      {
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'xhigh',
        fastMode: true,
      },
      'thread-openai',
    );
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(getSessionEffort(sessionId)).toBe('high');
    expect(getSessionFastMode(sessionId)).toBe(false);
    expect(h.service.has(sessionId)).toBe(false);
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.onCancellationCompensated).toHaveBeenCalledOnce();
    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledOnce();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
  });

  it('keeps cancellation gated and retries when persisted-route compensation fails', async () => {
    const sessionId = rememberSession('pending-switch-cancel-compensation-retry');
    setSessionProvider(sessionId, 'openai');
    const restoreStaleOwnerRoute = vi
      .fn()
      .mockRejectedValueOnce(new Error('sqlite temporarily unavailable'))
      .mockResolvedValueOnce(true);
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      { retryDelayMs: 5 },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback: vi.fn(async () => false),
    });
    h.persistRoute.mockImplementationOnce(async () => {
      h.service.clear(sessionId);
    });

    await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(h.onCancellationCompensated).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(restoreStaleOwnerRoute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.service.has(sessionId)).toBe(false));
    expect(h.onCancellationCompensated).toHaveBeenCalledOnce();
    expect(getSessionProvider(sessionId)).toBe('xd');
  });

  it('compensates the actual fallback route when the owner changes during persistence', async () => {
    const sessionId = rememberSession('pending-switch-owner-stale-during-fallback-persist');
    setSessionProvider(sessionId, 'xd');
    let ownerCurrent = true;
    const rollback = vi.fn(async () => true);
    const restoreStaleOwnerRoute = vi.fn(async () => true);
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        isOwnerScopeCurrent: () => ownerCurrent,
        resolveRoute: async () => ({
          model: 'gpt-5.6-sol',
          providerId: 'openai',
          degraded: true,
          effort: 'xhigh',
          fastMode: true,
        }),
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockResolvedValueOnce({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
      rollback,
    });
    h.persistRoute.mockImplementationOnce(async () => {
      ownerCurrent = false;
    });

    h.service.register(sessionId, {
      model: 'xai/grok-4.3',
      providerId: 'xai',
      agentKind: 'codex',
      ownerScope: { ownerScopeKey: 'owner-a', runtimeOwnerEpoch: '7' },
      sourceCodexThreadModelProviderId: 'cindy_gateway',
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });
    await h.service.onTurnSettled(sessionId);
    await vi.waitFor(() => expect(restoreStaleOwnerRoute).toHaveBeenCalledOnce());

    const persistedFallback = {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    };
    expect(h.persistRoute).toHaveBeenCalledWith(sessionId, persistedFallback);
    expect(rollback).not.toHaveBeenCalled();
    expect(restoreStaleOwnerRoute).toHaveBeenCalledWith(
      persistedFallback,
      'thread-openai',
    );
    expect(h.service.get(sessionId)).toBeUndefined();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('keeps an owner-stale persisted route gated until Profile compensation retry succeeds', async () => {
    const sessionId = rememberSession('pending-switch-owner-stale-compensation-retry');
    setSessionProvider(sessionId, 'xd');
    let ownerCurrent = true;
    let persistedProfile = {
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd' as string | null,
      effort: 'high',
      fastMode: false,
    };
    const rollback = vi.fn(async () => {
      if (persistedProfile.sdkSessionId !== 'thread-openai') return false;
      persistedProfile.sdkSessionId = 'thread-xd';
      return true;
    });
    const restoreStaleOwnerRoute = vi
      .fn()
      .mockRejectedValueOnce(new Error('sqlite temporarily unavailable'))
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (route, expectedSdkSessionId) => {
        if (
          persistedProfile.sdkSessionId !== expectedSdkSessionId ||
          persistedProfile.model !== route?.model ||
          persistedProfile.providerId !== route.providerId ||
          persistedProfile.effort !== route.effort ||
          persistedProfile.fastMode !== route.fastMode
        ) {
          return false;
        }
        persistedProfile = {
          sdkSessionId: 'thread-xd',
          model: 'codex/gpt-5.6-sol',
          providerId: 'xd',
          effort: 'high',
          fastMode: false,
        };
        return true;
      });
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      {
        retryDelayMs: 50,
        isOwnerScopeCurrent: () => ownerCurrent,
      },
    );
    h.relinkCodexThreadForProviderSwitch.mockImplementationOnce(async () => {
      persistedProfile.sdkSessionId = 'thread-openai';
      return {
        previousSdkSessionId: 'thread-xd',
        newSdkSessionId: 'thread-openai',
        rollback,
      };
    });
    h.persistRoute.mockImplementationOnce(async (_persistedSessionId, route) => {
      persistedProfile = {
        ...persistedProfile,
        model: route.model ?? persistedProfile.model,
        providerId: route.providerId,
        effort: route.effort ?? persistedProfile.effort,
        fastMode: route.fastMode ?? persistedProfile.fastMode,
      };
      ownerCurrent = false;
      // A concurrent queue probe can begin stale cleanup before persistRoute returns. The
      // finalizer must upgrade that in-flight cleanup with the persisted tuple + replacement id.
      expect(h.service.has(sessionId)).toBe(true);
    });

    await h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      rebuildCodexThread: true,
      ownerScope: { ownerScopeKey: 'owner-a', runtimeOwnerEpoch: '7' },
      previousRoute: {
        model: 'codex/gpt-5.6-sol',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      restoreStaleOwnerRoute,
    });
    await h.service.onTurnSettled(sessionId);

    expect(rollback).not.toHaveBeenCalled();
    expect(restoreStaleOwnerRoute).toHaveBeenCalledTimes(2);
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-openai',
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    });
    expect(h.service.has(sessionId)).toBe(true);
    expect(h.service.get(sessionId)).toBeUndefined();
    expect(h.onCancellationCompensated).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();

    expect(h.service.has(sessionId)).toBe(true);
    expect(persistedProfile.sdkSessionId).toBe('thread-openai');
    await vi.waitFor(() => expect(restoreStaleOwnerRoute).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(h.service.has(sessionId)).toBe(false));
    expect(restoreStaleOwnerRoute).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(restoreStaleOwnerRoute).toHaveBeenNthCalledWith(
      2,
      {
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'xhigh',
        fastMode: true,
      },
      'thread-openai',
    );
    expect(restoreStaleOwnerRoute).toHaveBeenNthCalledWith(
      3,
      {
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'xhigh',
        fastMode: true,
      },
      'thread-openai',
    );
    expect(persistedProfile).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
    expect(h.onCancellationCompensated).toHaveBeenCalledOnce();
    expect(h.relinkCodexThreadForProviderSwitch).toHaveBeenCalledOnce();
    expect(h.persistRoute).toHaveBeenCalledOnce();
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
  });

  it('does not commit an abandoned relink generation after the user cancels it', async () => {
    const sessionId = rememberSession('pending-switch-cancel-during-relink');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.relinkCodexThreadForProviderSwitch.mockImplementationOnce(async (input) => {
      h.service.clear(sessionId);
      expect(input.isCurrent()).toBe(false);
      throw new Error('superseded');
    });

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('re-registration overwrites the previous pending target (last click wins)', async () => {
    const sessionId = rememberSession('pending-switch-overwrite');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'openai' });
    await h.service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'openai',
    });
  });

  it('applies the route directly when the session was closed by another path', () => {
    const sessionId = rememberSession('pending-switch-closed');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.onSessionClosed(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('keeps the queue gated and never relinks while the live-session close is unconfirmed', async () => {
    const sessionId = rememberSession('pending-switch-close-failed');
    setSessionProvider(sessionId, 'xd');
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
      { retryDelayMs: 60_000 },
    );
    h.closeSession.mockRejectedValueOnce(new Error('close blew up'));

    h.service.register(sessionId, {
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      rebuildCodexThread: true,
      previousRoute: { model: 'codex/gpt-5.6-sol', providerId: 'xd' },
    });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.relinkCodexThreadForProviderSwitch).not.toHaveBeenCalled();
    expect(h.persistRoute).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    h.service.clear(sessionId);
  });

  it('applies the latest registration when the user re-selects during the async close (last click wins)', async () => {
    // review P1(2026-07-04):await closeSession 期间用户又切了一次来源,收口必须用
    // 当前登记而非进入函数时捕获的 stale target,否则后选被先选覆盖。
    const sessionId = rememberSession('pending-switch-reselect-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.register(sessionId, { model: 'gpt-5.4', providerId: 'openai' });
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.4',
      providerId: 'openai',
    });
  });

  it('respects a clear() issued during the async close and applies nothing', async () => {
    const sessionId = rememberSession('pending-switch-clear-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.clear(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('does not double-apply when its own close triggers the session-closed hook', async () => {
    // onTurnSettled 的 apply 内部 closeSession 会触发宿主的 closed 事件接线,
    // 该事件反过来调 onSessionClosed —— 完成权必须归 turn-settled 路径,只广播一次。
    const sessionId = rememberSession('pending-switch-reentrant-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      // 模拟 register.ts 的 closed 状态钩子在 close 过程中同步回调。
      service.onSessionClosed(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it('self-heals via the retry timer when the turn ends without a done/error event', async () => {
    // stop/interrupt/SDK crash 可能只发 status idle、不发 done/error:事件接线两条
    // 路径都不触发,pending 门会把队列冻死 —— 自愈定时器必须兜住。
    const sessionId = rememberSession('pending-switch-self-heal');
    setSessionProvider(sessionId, 'openai');
    let running = true;
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => running }],
      { retryDelayMs: 10 },
    );

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    // 第一轮定时器触发时仍在跑 → 保留 pending 并续期。
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.service.has(sessionId)).toBe(true);

    // turn 静默死亡(无 done/error 事件),tracker 归 idle。
    running = false;
    await vi.waitFor(() => {
      expect(h.service.has(sessionId)).toBe(false);
    }, { timeout: 1000, interval: 10 });
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue wake even when the applied broadcast throws', async () => {
    // broadcast 只是 UI 提示;它抛错(如目标窗口已销毁)不允许连带吞掉队列唤醒。
    const sessionId = rememberSession('pending-switch-broadcast-throw');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.broadcastApplied.mockImplementationOnce(() => {
      throw new Error('window destroyed');
    });

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await expect(h.service.onTurnSettled(sessionId)).resolves.toBeUndefined();

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('is a no-op for sessions without a pending switch', async () => {
    const h = createHarness([]);
    await h.service.onTurnSettled('never-registered');
    h.service.onSessionClosed('never-registered');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  describe('收口前的停用重裁决(PR #744 review 第七轮起,宽松降级形态)', () => {
    it('显式来源在等待期间被停用 ⇒ 按裁决改道到替代来源并回写 DB', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-reroute');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async (_a: string, model: string, _pid: string | null) => ({
        model,
        providerId: 'anthropic',
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('anthropic');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'anthropic',
        model: 'claude-opus-5',
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-opus-5',
        providerId: 'anthropic',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('目标模型全部拷贝被停用 ⇒ 连模型一起换到启用兜底并回写(store + DB + 广播)', async () => {
      // renderer 已把停用模型预写进 DB:只清来源不够 —— 下一次懒 resume 会经停用的
      // 隐式来源重建(resume 免裁决,PR #744 review 第十四轮)。
      const sessionId = rememberSession('pending-switch-revalidate-model-swap');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
        degraded: true,
        effort: 'low',
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('anthropic');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
        effort: 'low',
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('目标全停且无启用兜底 ⇒ 回滚到切换前路由(register 捕获的 previousRoute)', async () => {
      const sessionId = rememberSession('pending-switch-rollback-previous');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: undefined,
        providerId: null,
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
        // 回滚成套:renderer 已把目标 model/effort/fast 落盘,只回滚 model 会让旧
        // 模型配上目标档位被上游拒(第十八轮)。
        previousRoute: {
          model: 'claude-sonnet-4-6',
          providerId: 'openai',
          effort: 'high',
          fastMode: false,
        },
      });
      await h.service.onTurnSettled(sessionId);

      expect(getSessionProvider(sessionId)).toBe('openai');
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'openai',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        fastMode: false,
      });
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-sonnet-4-6',
        providerId: 'openai',
      });
    });

    it('回写失败 ⇒ fail-closed:保留登记(队列门不解除)、不广播、留给自愈重试', async () => {
      const sessionId = rememberSession('pending-switch-persist-fail');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async (_a: string, model: string) => ({
        model,
        providerId: 'anthropic',
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute, retryDelayMs: 60_000 },
      );
      h.persistRoute.mockRejectedValueOnce(new Error('disk on fire'));

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      // DB 还躺着 renderer 预写的停用目标:此刻唤醒队列 = 排队消息按停用路由懒 resume。
      expect(h.service.has(sessionId)).toBe(true);
      expect(h.onApplied).not.toHaveBeenCalled();
      expect(h.broadcastApplied).not.toHaveBeenCalled();
    });

    it('目录里一个启用对话模型都没有 ⇒ 只清显式来源(store null + DB 回写 null)', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-all-dead');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => ({
        model: undefined,
        providerId: null,
        degraded: true,
      }));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(getSessionProvider(sessionId)).toBeNull();
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: null,
        model: 'claude-opus-5',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('复核异常 ⇒ fail-closed:route 不写、保留登记(队列门不解除)、留给自愈重试', async () => {
      // DB 里躺着 renderer 预写的目标路由(可能恰在等待期间被停用),异常时收口唤醒
      // 会让排队消息按未经复核的路由懒 resume(PR #744 review 第二十轮)。
      const sessionId = rememberSession('pending-switch-revalidate-throw');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(async () => {
        throw new Error('catalog exploded');
      });
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute, retryDelayMs: 60_000 },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(true);
      expect(getSessionProvider(sessionId)).toBe('openai');
      expect(h.persistRoute).not.toHaveBeenCalled();
      expect(h.onApplied).not.toHaveBeenCalled();
      expect(h.broadcastApplied).not.toHaveBeenCalled();
    });

    it('裁决通过 ⇒ 原样应用;register 未带 agentKind ⇒ 双 agent 保守,不采纳跨 agent 结果', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-pass');
      setSessionProvider(sessionId, 'openai');
      const resolveRoute = vi.fn(
        async (_a: string, model: string, providerId: string | null) => ({
          model,
          providerId,
          degraded: false,
        }),
      );
      const h = createHarness(
        [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute },
      );

      h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd', agentKind: 'codex' });
      await h.service.onTurnSettled(sessionId);
      expect(getSessionProvider(sessionId)).toBe('xd');
      // R23:裁决接线存在时收口恒写幂等回正(吸收旧 finalizer 迟到写竞态),
      // 路由未改也回写 (providerId, model) —— 对 renderer 已写值的幂等重写。
      expect(h.persistRoute).toHaveBeenCalledWith(sessionId, {
        providerId: 'xd',
        model: 'gpt-5.5',
      });
      expect(resolveRoute).toHaveBeenCalledWith('codex', 'gpt-5.5', 'xd', {
        desiredFastMode: false,
      });

      // agentKind 缺席:任一 agent 的裁决要求改动(此处 codex 判 reroute)即清空显式
      // 来源,绝不把按别的 agent 解析出的来源钉给真实会话(第十二、十三轮)。
      const sessionId2 = rememberSession('pending-switch-no-agentkind');
      setSessionProvider(sessionId2, 'openai');
      const resolveRoute2 = vi.fn(async (agent: string, model: string, providerId: string | null) =>
        agent === 'codex'
          ? { model, providerId: 'anthropic', degraded: true }
          : { model, providerId, degraded: false },
      );
      const h2 = createHarness(
        [{ id: sessionId2, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
        { resolveRoute: resolveRoute2 },
      );
      h2.service.register(sessionId2, { model: 'gpt-5.5', providerId: 'xd' });
      await h2.service.onTurnSettled(sessionId2);
      expect(h2.service.has(sessionId2)).toBe(false);
      expect(getSessionProvider(sessionId2)).toBeNull();
      expect(resolveRoute2).toHaveBeenCalledWith('claude-code', 'gpt-5.5', 'xd');
      expect(resolveRoute2).toHaveBeenCalledWith('codex', 'gpt-5.5', 'xd');
    });
  });
});
