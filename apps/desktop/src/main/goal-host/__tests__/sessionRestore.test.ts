import { describe, expect, it, vi } from 'vitest';

import { AcpAgent, createConsoleLogger, type AcpLineTransport, type Session, type SessionMeta } from '@cindy/maker-core';

import { applyLeadVendorOptions, createAcpLeadBriefingHandoff, preparePersistedOrcaSessionStart } from '../../maker-ipc/orcaSessionStartOptions';

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

  // ACP harness §5, unit: a promoted Lead can be dormant when Goal restores it,
  // before bootstrap could deliver its briefing. Exercise the real Goal restore,
  // common Orca preparation and ACP prompt boundary without replacing the native id.
  it('carries a pending ACP Lead briefing through Goal restore only once', async () => {
    const providerId = 'acp-plugin:fixture:engine';
    const handoff = createAcpLeadBriefingHandoff({
      currentOwner: () => 'owner-1',
      readActiveTeamId: async () => 'team-1',
      readRole: async () => 'lead',
    });
    await applyLeadVendorOptions(handoff, {
      leadSessionId: META.id,
      teamId: 'team-1',
      newTeam: true,
      admittedLeadAgentKind: 'acp',
    }, undefined, () => {});
    const readRole = { getSessionRole: async () => 'lead' as const, getWorkerLink: vi.fn(), warn: vi.fn() };
    const sent: Array<{ method: string; params: { sessionId?: string; prompt?: Array<{ text: string }> } }> = [];
    let onLine: ((line: string) => void) | undefined;
    const transport: AcpLineTransport = {
      write(line) {
        const request = JSON.parse(line);
        sent.push(request);
        const result = request.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } } }
          : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
        queueMicrotask(() => onLine?.(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })));
      },
      onLine(listener) { onLine = listener; return () => { onLine = undefined; }; },
      onClose: () => () => {},
      close: async () => {},
    };
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: createConsoleLogger('goal-acp-restore-test'),
      clientInfo: { name: 'test', version: '1' }, endpoints: { connect: async () => transport },
      preparePiExtraSpawnConfig: async () => ({
        mcpBridge: { token: 'fixture', servers: [{ name: 'cindy_orca', url: 'http://127.0.0.1:1/mcp/cindy_orca' }] },
      }),
    });
    let handle: Awaited<ReturnType<AcpAgent['startSession']>> | undefined;
    const deps = baseDeps({
      maker: {
        getSession: vi.fn(),
        getSessionMeta: vi.fn().mockResolvedValue({ ...META, agentKind: 'acp' }),
        createSession: async (opts) => {
          // Like Maker's lifecycle hook, prepare the startup copy a second time.
          const start = { ...opts };
          await preparePersistedOrcaSessionStart(META.id, start, readRole, handoff);
          handle = await engine.startSession({ ...start, sessionId: META.id });
          return fakeSession();
        },
      },
      prepareOrcaStart: (id, opts) => preparePersistedOrcaSessionStart(id, opts, readRole, handoff),
      getSessionRow: async () => ({ providerId }),
    });
    for (const message of ['Continue the goal', 'Continue again']) {
      try {
        expect(await restoreSessionForGoal(META.id, deps)).toBeDefined();
        await handle!.send({ type: 'user', content: message });
      } finally {
        await handle?.close();
      }
    }
    expect(sent.filter(event => event.method === 'session/resume').map(event => event.params.sessionId))
      .toEqual([META.sdkSessionId, META.sdkSessionId]);
    const prompts = sent.filter(event => event.method === 'session/prompt').map(event => event.params.prompt);
    expect(prompts).toEqual([
      [{ type: 'text', text: expect.stringContaining('You lead an Orca team.') }, { type: 'text', text: 'Continue the goal' }],
      [{ type: 'text', text: 'Continue again' }],
    ]);
    expect(handoff.hasPending(META.id)).toBe(false);
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
