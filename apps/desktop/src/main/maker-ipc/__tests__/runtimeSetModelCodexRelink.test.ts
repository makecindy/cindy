import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { applyRuntimeSetModelChange, type RuntimeSetModelMaker } from '../runtimeSetModel.js';
import { isUserCodexSourceSwitch } from '../sessionRuntimeSelectionApply.js';

const sourceSwitchRecords = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../sourceSwitchStore.js', () => ({
  recordSourceSwitch: sourceSwitchRecords,
  recordSourceSwitchBestEffort: sourceSwitchRecords,
  matchesSourceSwitch: vi.fn(() => false),
  consumeSourceSwitch: vi.fn(async () => {}),
}));


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
      await expect(result).resolves.toEqual(state === 'moved'
        ? { status: 'applied', persistedRoute: true, retiredRuntime: true }
        : { status: 'applied', retiredRuntime: true });
    }
    expect(relink).toHaveBeenCalledTimes(state === 'moved' ? 1 : 0);
  });

  // 换源时不再先 fork 旧线程：fork 要向旧账号申请授权，而旧账号正是用户离开的那个
  // （2026-11-25 实报：换源被旧登录挡住）。交接交给发送前的 rebuild 完成。
  it('hands the thread over instead of forking it into the source the user just left', async () => {
    const sessionId = rememberSession('user-source-switch-handoff');
    setSessionProvider(sessionId, 'cprov-source');
    const relink = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', setModel: vi.fn(),
        requiresModelSwitchRebuild: async () => true }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => false }],
      closeSession,
    };
    await expect(applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      handOffCodexThread: true, requiresCodexThreadRelink: async () => true, relinkCodexThread: relink }))
      .resolves.toEqual({ status: 'applied', retiredRuntime: true });
    expect(closeSession).toHaveBeenCalledOnce();
    expect(relink).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('cprov-target');
  });

  // 冷会话（没有 live handle）换源也要落路由：不能因为跳过线程迁移就连来源一起丢掉。
  it('publishes the picked source for a cold task without forking its thread', async () => {
    const sessionId = rememberSession('user-source-switch-cold');
    setSessionProvider(sessionId, 'cprov-source');
    const relink = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => undefined,
      listActiveSessions: () => [],
      closeSession: async () => {},
    };
    await expect(applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      handOffCodexThread: true, requiresCodexThreadRelink: async () => true, relinkCodexThread: relink }))
      .resolves.toEqual({ status: 'applied' });
    expect(relink).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('cprov-target');
  });

  // 不在交接范围内的换源（BYOK→BYOK、订阅→BYOK 等目标没有本机账号池）照旧先迁移线程：
  // 那里没有替代交接，跳过 fork 会把请求交给一个读不到旧线程的来源。
  it.each([
    ['byok-a', 'byok-b'],
    ['openai', 'byok-b'],
  ] as const)('keeps the thread fork for an out-of-scope source change (%s → %s)', async (from, to) => {
    const sessionId = rememberSession(`out-of-scope-switch-${from}-${to}`);
    setSessionProvider(sessionId, from);
    const relink = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', setModel: vi.fn(),
        requiresModelSwitchRebuild: async () => true }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => false }],
      closeSession: async () => {},
    };
    sourceSwitchRecords.mockClear();
    await expect(applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: to,
      handOffCodexThread: false, requiresCodexThreadRelink: async () => true, relinkCodexThread: relink }))
      .resolves.toEqual({ status: 'applied', persistedRoute: true, retiredRuntime: true });
    expect(relink).toHaveBeenCalledOnce();
    expect(getSessionProvider(sessionId)).toBe(to);
    // 不在交接范围的换源不写记录：那里没有替代交接，记录也永远不会被消费。
    expect(sourceSwitchRecords).not.toHaveBeenCalled();
  });

  // 旧账号已失效 + 旧线程仍被另一个进程加载：这就是实测里换源被挡住的组合。
  // 交接改由发送前完成，入口不去 fork，也就不再向旧账号申请权限；旧的 fork 若被调用会抛错。
  it('does not need the old account when the loaded thread belongs to the source being left', async () => {
    const sessionId = rememberSession('user-source-switch-broken-old-login');
    setSessionProvider(sessionId, 'cprov-source');
    const relink = vi.fn(async () => { throw new Error('the old account requires sign-in'); });
    const closeSession = vi.fn(async () => {});
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', setModel: vi.fn(),
        requiresModelSwitchRebuild: async () => true }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => false }],
      closeSession,
    };
    sourceSwitchRecords.mockClear();
    await expect(applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      handOffCodexThread: true, requiresCodexThreadRelink: async () => true, relinkCodexThread: relink }))
      .resolves.toEqual({ status: 'applied', retiredRuntime: true });
    expect(relink).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('cprov-target');
    // 换源记录随已提交的路由落盘；下一步发送据此交接（重启后仍有效）。
    expect(sourceSwitchRecords).toHaveBeenCalledExactlyOnceWith(sessionId, 'cprov-target');
  });

  it('keeps failing closed on the old account when the switch is not a user source switch', async () => {
    const sessionId = rememberSession('non-user-source-switch-broken-old-login');
    setSessionProvider(sessionId, 'cprov-source');
    const relink = vi.fn(async () => { throw new Error('the old account requires sign-in'); });
    const maker: RuntimeSetModelMaker = {
      getSession: () => ({ agentKind: 'codex', model: 'source', setModel: vi.fn(),
        requiresModelSwitchRebuild: async () => true }),
      listActiveSessions: () => [{ id: sessionId, agentKind: 'codex', isTurnRunning: () => false }],
      closeSession: async () => {},
    };
    await expect(applyRuntimeSetModelChange({ maker, sessionId, model: 'target', providerId: 'cprov-target',
      requiresCodexThreadRelink: async () => true, relinkCodexThread: relink }))
      .rejects.toThrow('the old account requires sign-in');
    expect(relink).toHaveBeenCalledOnce();
    expect(getSessionProvider(sessionId)).toBe('cprov-source');
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
      await expect(switching).resolves.toEqual({ status: 'applied', persistedRoute: true, retiredRuntime: true });
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
    ).resolves.toEqual({ status: 'applied', persistedRoute: true, retiredRuntime: true });

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

// 入口判定：只有「用户、codex、本机、目标有账号池、来源确实变了」才算换源交接。
describe('isUserCodexSourceSwitch', () => {
  const base = { source: 'user', agentKind: 'codex', currentProviderId: 'openai-old',
    nextProviderId: 'openai', local: true, handoffPool: true };
  it.each([
    ['user codex switch with a pool', base, true],
    ['model-only selection', { ...base, nextProviderId: 'openai-old' }, false],
    ['agent picked the source', { ...base, source: 'agent' }, false],
    ['non-codex task', { ...base, agentKind: 'claude-code' }, false],
    ['remote or other-computer task', { ...base, local: false }, false],
    ['BYOK → BYOK destination (no pool)', { ...base, handoffPool: false }, false],
    ['subscription → BYOK destination (no pool)', { ...base, handoffPool: false }, false],
  ] as const)('%s', (_label, input, expected) => {
    expect(isUserCodexSourceSwitch(input)).toBe(expected);
  });
});
