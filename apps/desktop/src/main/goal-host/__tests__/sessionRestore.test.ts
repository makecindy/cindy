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
});
