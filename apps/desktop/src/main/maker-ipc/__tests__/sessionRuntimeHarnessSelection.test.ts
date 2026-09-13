import { describe, expect, it, vi } from 'vitest';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../sessionAgentSwitchHandler';
import {
  pendingHarnessRuntimeMutation,
  setSessionRuntimeHarness,
  type HarnessRuntimeSelectionDeps,
} from '../sessionRuntimeHarnessSelection';
import type { SessionRuntimeProfile } from '../sessionRuntimeControl';

function setup(running = false) {
  let generation = 4;
  let owner = 'owner-1';
  const pending = createPendingAgentSwitchRegistry();
  const effective: SessionRuntimeProfile = {
    agentKind: 'claude-code',
    model: 'claude-fable-5',
    providerId: 'old-provider',
    effort: 'high',
    fastMode: false,
  };
  const close = vi.fn();
  const persist = vi.fn();
  const switchDeps = {
    getSessionRow: vi.fn(async () => ({
      id: 's1',
      agentKind: 'cc',
      model: effective.model,
      providerId: 'old-provider',
      status: 'active',
      remoteHostId: null,
      orcaRole: null,
      sdkSessionId: 'native-1',
    })),
    getLiveSession: () => ({ isTurnRunning: () => running }),
    pendingSwitches: pending,
    onPendingSwitchChanged: () => {
      generation++;
    },
    closeSession: close,
    applyAgentSwitchToDb: persist,
    supersedePendingCredentialSwitch: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as MakerSessionAgentSwitchHandlerDeps;
  const deps: HarnessRuntimeSelectionDeps = {
    withSessionLock: async (_id, run) => run(),
    ownerEpoch: () => owner,
    generation: () => generation,
    pendingRevision: (id) => pending.revision!(id),
    read: vi.fn(async () => effective),
    resolve: vi.fn(async (profile) => ({ ...profile, providerId: profile.providerId ?? 'openai' })),
    stage: (id, profile, assertCurrent) =>
      performSessionAgentSwitch(switchDeps, {
        sessionId: id,
        targetAgentKind: profile.agentKind,
        model: profile.model,
        providerId: profile.providerId,
        effort: profile.effort,
        fastMode: profile.fastMode,
        runtimeSource: 'agent',
        assertSelectionCurrent: assertCurrent,
      }),
    pending: (id) => pending.get(id),
  };
  return {
    deps,
    pending,
    switchDeps,
    close,
    persist,
    effective,
    bump: () => generation++,
    logout: () => {
      owner = 'owner-2';
    },
  };
}

const request = {
  targetSessionId: 's1',
  expectedGeneration: 4,
  patch: { harness: 'codex' as const, model: 'gpt-6-astra' },
};

describe('runtime harness selection', () => {
  it('blocks sending on the old harness when the accepted target becomes unavailable', async () => {
    const h = setup();
    await setSessionRuntimeHarness(h.deps, request);
    const intent = h.pending.get('s1');
    h.switchDeps.assertModelRouteUsable = async () => {
      throw new Error('provider disabled');
    };
    await expect(applyPendingAgentSwitchIfIdle(h.switchDeps, 's1')).rejects.toThrow(
      'provider disabled',
    );
    expect(h.pending.get('s1')).toBe(intent);
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'stages until send, without interrupting or persisting (running=%s)',
    async (running) => {
      const h = setup(running);
      const result = await setSessionRuntimeHarness(h.deps, request);
      expect(result).toMatchObject({
        ok: true,
        status: 'deferred',
        effectiveBoundary: 'next_send',
        generation: 5,
        effectiveProfile: h.effective,
        pendingMutation: {
          generation: 5,
          source: 'agent',
          profile: { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' },
        },
      });
      expect(h.close).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
      expect(pendingHarnessRuntimeMutation(h.pending.get('s1'), 5)).toEqual(
        result.ok && result.pendingMutation,
      );
    },
  );

  it.each(['stale', 'during-resolution', 'during-row-read', 'logout', 'intent-revision'])(
    'rejects concurrent mutation: %s',
    async (when) => {
      const h = setup();
      if (when === 'stale') h.bump();
      if (when === 'during-resolution')
        h.deps.resolve = async (p) => {
          h.bump();
          return p;
        };
      if (when === 'logout')
        h.deps.resolve = async (p) => {
          h.logout();
          return p;
        };
      if (when === 'intent-revision')
        h.deps.resolve = async (p) => {
          h.pending.clear('s1');
          return p;
        };
      if (when === 'during-row-read') {
        const read = h.switchDeps.getSessionRow;
        h.switchDeps.getSessionRow = async (id) => {
          const row = await read(id);
          h.bump();
          return row;
        };
      }
      expect(await setSessionRuntimeHarness(h.deps, request)).toMatchObject({
        ok: false,
        errorCode: 'CONFLICT',
      });
      expect(h.pending.get('s1')).toBeUndefined();
      expect(h.switchDeps.supersedePendingCredentialSwitch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { remoteHostId: 'ssh-host' },
    { orcaRole: 'lead' },
    { source: 'review' },
    { status: 'deleted' },
    { status: 'archived' },
  ])('preserves existing intent when target is ineligible: %j', async (overrides) => {
    const h = setup();
    const previous = { targetAgentKind: 'pi' as const, model: 'old-choice', providerId: null };
    h.pending.set('s1', previous);
    const read = h.switchDeps.getSessionRow;
    h.switchDeps.getSessionRow = async (id) => ({ ...(await read(id))!, ...overrides });
    expect(await setSessionRuntimeHarness(h.deps, request)).toMatchObject({ ok: false });
    expect(h.pending.get('s1')).toBe(previous);
    expect(h.close).not.toHaveBeenCalled();
  });

  it('preserves selections after target route validation fails', async () => {
    const h = setup();
    h.deps.resolve = async () => {
      throw Object.assign(new Error('unavailable target'), { code: 'INVALID_PARAMS' });
    };
    expect(await setSessionRuntimeHarness(h.deps, request)).toMatchObject({
      ok: false,
      errorCode: 'ROUTE_UNAVAILABLE',
    });
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it('passes the CAS guard through same-harness model validation', async () => {
    const h = setup();
    h.switchDeps.selectSameAgentModel = async (_id, intent, applyNow, assertCurrent) => {
      expect(intent.runtimeSource).toBe('agent');
      expect(applyNow).toBe(false);
      h.bump();
      assertCurrent?.();
      throw new Error('stale choice must not be staged');
    };
    expect(
      await setSessionRuntimeHarness(h.deps, {
        ...request,
        patch: { harness: 'claude-code', model: 'claude-fable-5' },
      }),
    ).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
  });

  it('requires model and generation and does not expose picker intents as Agent overrides', async () => {
    const h = setup();
    expect(
      await setSessionRuntimeHarness(h.deps, { ...request, patch: { harness: 'codex' } }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(
      await setSessionRuntimeHarness(h.deps, { ...request, expectedGeneration: undefined }),
    ).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect(
      pendingHarnessRuntimeMutation(
        { targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: null },
        4,
      ),
    ).toBeNull();
  });
});
