import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session, SessionMeta } from '@cindy/maker-core';

import { restoreSessionForGoal, type RestoreGoalSessionDeps } from '../sessionRestore';
import {
  setSessionRouteLockImplementation,
  withSessionRouteLock,
  type SessionRouteLock,
} from '../../localDb/sessionRouteLock';

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
  afterEach(() => setSessionRouteLockImplementation(null));

  function installRouteLock() {
    let tail = Promise.resolve();
    const lock: SessionRouteLock = async (_sessionId, run) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    };
    setSessionRouteLockImplementation(lock);
  }

  it('waits for a project move to commit before reading metadata or restoring its runtime', async () => {
    installRouteLock();
    let finishMove!: () => void;
    const moving = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    let meta = { ...META, workDir: '/old-project' };
    const deps = baseDeps();
    vi.mocked(deps.maker.getSessionMeta).mockImplementation(async () => meta);
    const migration = withSessionRouteLock('session-1', async () => {
      await moving;
      meta = { ...meta, workDir: '/new-project' };
    });

    const restored = restoreSessionForGoal('session-1', deps);
    await Promise.resolve();
    expect(deps.maker.getSessionMeta).not.toHaveBeenCalled();
    expect(deps.maker.createSession).not.toHaveBeenCalled();

    finishMove();
    await migration;
    await restored;
    expect(deps.maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: '/new-project',
      }),
    );
  });

  it('restores under an existing direct-send lease without reacquiring its non-reentrant lock', async () => {
    installRouteLock();
    const deps = baseDeps();

    await expect(
      withSessionRouteLock('session-1', () =>
        restoreSessionForGoal('session-1', deps, { routeLockHeld: true }),
      ),
    ).resolves.toMatchObject({ id: 'session-1' });
    expect(deps.maker.createSession).toHaveBeenCalledOnce();
  });

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
});
