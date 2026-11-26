import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionMeta } from '@cindy/maker-core';

import { restoreSessionForGoal, type RestoreGoalSessionDeps } from '../sessionRestore';

const META: SessionMeta = {
  id: 'session-1',
  agentKind: 'codex',
  workDir: '/repo',
  title: 'Session',
  model: 'gpt-5',
  createdAt: 1,
  updatedAt: 1,
  sdkSessionId: 'thread-1',
};

function fakeSession(): Session {
  return {
    id: 'session-1',
    agentKind: 'codex',
    send: vi.fn(),
    onEvent: vi.fn(),
    isTurnRunning: vi.fn().mockReturnValue(false),
    abort: vi.fn(),
  } as unknown as Session;
}

function baseDeps(overrides: Partial<RestoreGoalSessionDeps> = {}): RestoreGoalSessionDeps {
  return {
    maker: {
      getSession: vi.fn(),
      getSessionMeta: vi.fn().mockResolvedValue(META),
      createSession: vi.fn().mockResolvedValue(fakeSession()),
    },
    warn: vi.fn(),
    getSessionRow: vi.fn().mockResolvedValue({ providerId: 'provider-1' }),
    hydrateProvider: vi.fn(),
    prepareOrcaStart: vi.fn().mockResolvedValue(true),
    markOrcaHydrated: vi.fn(),
    wireSession: vi.fn(),
    ...overrides,
  };
}

describe('Goal dormant session restore', () => {
  it('prepares persisted Orca context before entering Maker singleflight', async () => {
    const order: string[] = [];
    const deps = baseDeps({
      prepareOrcaStart: vi.fn().mockImplementation(async (_sessionId, opts) => {
        order.push('prepare');
        opts.vendorOptions = { orcaRole: 'lead', orcaLeadSessionId: 'session-1' };
        opts.userPrompt = 'orca lead instructions';
        return true;
      }),
    });
    vi.mocked(deps.maker.createSession).mockImplementation(async (opts) => {
      order.push('create');
      expect(opts.vendorOptions).toMatchObject({ orcaRole: 'lead' });
      expect(opts.userPrompt).toBe('orca lead instructions');
      return fakeSession();
    });
    vi.mocked(deps.markOrcaHydrated!).mockImplementation(() => {
      order.push('mark');
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toMatchObject({
      id: 'session-1',
    });

    expect(order).toEqual(['prepare', 'create', 'mark']);
    expect(deps.hydrateProvider).toHaveBeenCalledWith('session-1', 'provider-1');
    expect(deps.wireSession).toHaveBeenCalledOnce();
  });

  it('rebuilds an error Session instead of returning the poisoned live object', async () => {
    const poisoned = {
      ...fakeSession(),
      getStatus: vi.fn().mockReturnValue('error'),
    } as unknown as Session;
    const replacement = fakeSession();
    const deps = baseDeps({
      maker: {
        getSession: vi.fn().mockReturnValue(poisoned),
        getSessionMeta: vi.fn().mockResolvedValue(META),
        createSession: vi.fn().mockResolvedValue(replacement),
      },
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBe(replacement);

    expect(deps.maker.createSession).toHaveBeenCalledOnce();
    expect(deps.wireSession).toHaveBeenCalledWith(replacement);
  });

  it('preserves a persisted null provider route when restoring a Pi session', async () => {
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue({ ...META, agentKind: 'pi' }),
        createSession: vi.fn().mockResolvedValue(fakeSession()),
      },
      getSessionRow: vi.fn().mockResolvedValue({ providerId: null }),
    });

    await restoreSessionForGoal('session-1', deps);

    expect(deps.maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'pi', providerId: null }),
    );
    expect(deps.hydrateProvider).toHaveBeenCalledWith('session-1', null);
  });

  it('marks Orca hydration only after successful session creation', async () => {
    const markOrcaHydrated = vi.fn();
    const warn = vi.fn();
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue(META),
        createSession: vi.fn().mockRejectedValue(new Error('start failed')),
      },
      markOrcaHydrated,
      warn,
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBeUndefined();

    expect(markOrcaHydrated).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[goal-host] ensureSession createSession failed',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  // 2026-11-25 用户要求插件引擎在所有地方与内置引擎一样可用：此前休眠的插件引擎任务设目标时不恢复、目标直接失败。
  // 现在按它自己的引擎恢复(任务行的 providerId 指出引擎，另一台电脑上的引擎留在那台)，绝不在内置引擎上恢复。
  // 最小失败输入：persisted meta agentKind 'acp'。tier：unit。
  it('resumes a dormant plugin-engine task on its own engine', async () => {
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue({ ...META, agentKind: 'acp', agentDeviceId: 'studio' }),
        createSession: vi.fn().mockResolvedValue(fakeSession()),
      },
      getSessionRow: vi.fn().mockResolvedValue({ providerId: 'acp-plugin:agy:agy' }),
    });

    await expect(restoreSessionForGoal('session-1', deps)).resolves.toBeDefined();

    expect(deps.maker.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1', agentKind: 'acp', providerId: 'acp-plugin:agy:agy', agentDeviceId: 'studio',
      resumeSessionId: 'thread-1', fastMode: false,
    }));
    expect(deps.hydrateProvider).toHaveBeenCalledWith('session-1', 'acp-plugin:agy:agy');
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
