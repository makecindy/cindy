import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { applyRuntimeSetModelChange, type RuntimeSetModelMaker } from '../runtimeSetModel.js';

const sessionProviderWriteObserver = vi.hoisted(() => ({
  current: null as ((sessionId: string, providerId: string | null) => void) | null,
}));

vi.mock('../../maker-host/session-provider-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../maker-host/session-provider-store.js')>();
  return {
    ...actual,
    setSessionProvider: (sessionId: string, providerId: string | null) => {
      actual.setSessionProvider(sessionId, providerId);
      sessionProviderWriteObserver.current?.(sessionId, providerId);
    },
  };
});

const touchedSessions = new Set<string>();

afterEach(() => {
  sessionProviderWriteObserver.current = null;
  for (const sessionId of touchedSessions) clearSessionProvider(sessionId);
  touchedSessions.clear();
});

function rememberSession(sessionId: string): string {
  touchedSessions.add(sessionId);
  return sessionId;
}

// Exercise both credential directions with the actual discounted and subscription IDs.
const routeCases = ['codex/gpt-5.6-sol', 'codex/gpt-5.6-luna'].flatMap((discounted) => [
  {
    sourceProvider: 'xd',
    sourceModel: discounted,
    targetProvider: 'openai',
    targetModel: 'gpt-6-astra',
  },
  {
    sourceProvider: 'openai',
    sourceModel: 'gpt-6-astra',
    targetProvider: 'xd',
    targetModel: discounted,
  },
]);

describe('Codex writer decision freshness', () => {
  it.each(['released', 'moved', 'failed'])('rechecks the writer after close: %s', async (state) => {
    const sessionId = rememberSession(`post-close-${state}`);
    setSessionProvider(sessionId, 'cprov-source');
    let closed = false;
    const relink = vi.fn(async () => {});
    const restore = vi.fn();
    const pending = { model: 'earlier', providerId: 'cprov-earlier' };
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', setModel: vi.fn(), requiresModelSwitchRebuild: async () => true }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => false }],
      closeSession: async () => { closed = true; },
    };
    const result = applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      requiresCodexThreadRelink: async () => {
        if (closed && state === 'failed') throw new Error('writer lookup failed');
        return closed && state === 'moved';
      }, relinkCodexThread: relink, getPendingCredentialSwitch: () => pending,
      clearPendingCredentialSwitch: vi.fn(), registerPendingCredentialSwitch: restore });
    if (state === 'failed') {
      await expect(result).rejects.toThrow('writer lookup failed');
      expect(restore).toHaveBeenCalledWith(sessionId, pending);
      expect(getSessionProvider(sessionId)).toBe('cprov-source');
    } else {
      await expect(result).resolves.toEqual(state === 'moved' ? { status: 'applied', persistedRoute: true } : { status: 'applied' });
    }
    expect(relink).toHaveBeenCalledTimes(state === 'moved' ? 1 : 0);
  });

  it.each([false, true])('rechecks after asynchronous model inspection with busy=%s', async (busy) => {
    const sessionId = rememberSession('route-changes-during-inspection');
    setSessionProvider(sessionId, 'cprov-source');
    let requiresTransfer = false;
    const relink = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const registerPendingCredentialSwitch = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', remoteHostId: null,
        setModel: vi.fn(), requiresModelSwitchRebuild: async () => { requiresTransfer = true; return true; } }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => busy }],
      closeSession,
    };
    const switching = applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      requiresCodexThreadRelink: async () => requiresTransfer, relinkCodexThread: relink, registerPendingCredentialSwitch });
    if (busy) {
      await expect(switching).rejects.toThrow(/busy/);
      expect(closeSession).not.toHaveBeenCalled();
      expect(relink).not.toHaveBeenCalled();
      expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    } else {
      await expect(switching).resolves.toEqual({ status: 'applied', persistedRoute: true });
      expect(closeSession).toHaveBeenCalledOnce();
      expect(relink).toHaveBeenCalledOnce();
    }
  });
});

describe.each(routeCases)('Codex route: $sourceModel → $targetModel', (route) => {
  const { sourceProvider, sourceModel, targetProvider, targetModel } = route;
  it('closes, relinks, then publishes the idle target route', async () => {
    const sessionId = rememberSession('runtime-set-model-atomic-relink');
    setSessionProvider(sessionId, sourceProvider);
    const order: string[] = [];
    const closeSession = vi.fn(async () => {
      order.push('close');
    });
    const relinkCodexThread = vi.fn(async () => {
      order.push('relink');
    });
    const wakeSessionInputQueue = vi.fn(() => {
      order.push('wake');
    });
    sessionProviderWriteObserver.current = (writtenSessionId, providerId) => {
      if (writtenSessionId === sessionId && providerId === targetProvider) order.push('route');
    };
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: sourceModel,
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
      ],
      closeSession,
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: targetModel,
        providerId: targetProvider,
        requiresCodexThreadRelink: true,
        relinkCodexThread,
        clearPendingCredentialSwitch: vi.fn(),
        wakeSessionInputQueue,
      }),
    ).resolves.toEqual({ status: 'applied', persistedRoute: true, runtimeRetired: true });

    expect(order).toEqual(['close', 'relink', 'route', 'wake']);
    expect(getSessionProvider(sessionId)).toBe(targetProvider);
  });

  it('fails closed instead of registering pending work while the task is busy', async () => {
    const sessionId = rememberSession('runtime-set-model-busy-relink');
    setSessionProvider(sessionId, sourceProvider);
    const registerPendingCredentialSwitch = vi.fn();
    const relinkCodexThread = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: sourceModel,
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
      ],
      closeSession,
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: targetModel,
        providerId: targetProvider,
        requiresCodexThreadRelink: true,
        relinkCodexThread,
        registerPendingCredentialSwitch,
      }),
    ).rejects.toThrow(/busy/);

    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(relinkCodexThread).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe(sourceProvider);
  });

  it('still fails closed when the task becomes busy during the close preflight', async () => {
    const sessionId = rememberSession('runtime-set-model-busy-race-relink');
    setSessionProvider(sessionId, sourceProvider);
    let busyCheck = 0;
    const registerPendingCredentialSwitch = vi.fn();
    const relinkCodexThread = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: sourceModel,
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        {
          id: sessionId,
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => ++busyCheck > 1,
        },
      ],
      closeSession,
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: targetModel,
        providerId: targetProvider,
        requiresCodexThreadRelink: true,
        relinkCodexThread,
        registerPendingCredentialSwitch,
        clearPendingCredentialSwitch: vi.fn(),
      }),
    ).rejects.toThrow(/busy/);

    expect(registerPendingCredentialSwitch).not.toHaveBeenCalled();
    expect(relinkCodexThread).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe(sourceProvider);
  });

  it('relinks a persisted thread even without a live Session handle', async () => {
    const sessionId = rememberSession('runtime-set-model-cold-relink');
    setSessionProvider(sessionId, sourceProvider);
    const relinkCodexThread = vi.fn(async () => {});
    const wakeSessionInputQueue = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => undefined,
      listActiveSessions: () => [],
      closeSession: vi.fn(async () => {}),
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: targetModel,
        providerId: targetProvider,
        requiresCodexThreadRelink: true,
        relinkCodexThread,
        wakeSessionInputQueue,
      }),
    ).resolves.toEqual({ status: 'applied', persistedRoute: true });

    expect(relinkCodexThread).toHaveBeenCalledOnce();
    expect(wakeSessionInputQueue).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe(targetProvider);
  });

  it('keeps the source provider route when rebuilding the persisted thread fails', async () => {
    const sessionId = rememberSession('runtime-set-model-relink-failed');
    setSessionProvider(sessionId, sourceProvider);
    const oldPending = { model: sourceModel, providerId: sourceProvider };
    const registerPendingCredentialSwitch = vi.fn(async () => {});
    const clearPendingCredentialSwitch = vi.fn();
    const closeSession = vi.fn(async () => {});
    const relinkCodexThread = vi.fn(async () => {
      throw new Error('fork child sanitization failed');
    });
    const wakeSessionInputQueue = vi.fn();
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({
        agentKind: 'codex',
        remoteHostId: null,
        model: sourceModel,
        setModel: vi.fn(async () => {}),
      }),
      listActiveSessions: () => [
        { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
      ],
      closeSession,
    };

    await expect(
      applyRuntimeSetModelChange({
        maker,
        sessionId,
        model: targetModel,
        providerId: targetProvider,
        requiresCodexThreadRelink: true,
        relinkCodexThread,
        getPendingCredentialSwitch: () => oldPending,
        registerPendingCredentialSwitch,
        clearPendingCredentialSwitch,
        wakeSessionInputQueue,
      }),
    ).rejects.toThrow('fork child sanitization failed');

    expect(clearPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, { wake: false });
    expect(registerPendingCredentialSwitch).toHaveBeenCalledWith(sessionId, oldPending);
    expect(closeSession).toHaveBeenCalledWith(sessionId, 'runtime-refresh');
    expect(relinkCodexThread).toHaveBeenCalledOnce();
    expect(getSessionProvider(sessionId)).toBe(sourceProvider);
    expect(wakeSessionInputQueue).not.toHaveBeenCalled();
  });
});
