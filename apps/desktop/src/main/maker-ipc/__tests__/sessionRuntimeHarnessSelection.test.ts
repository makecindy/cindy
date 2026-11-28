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
  userStagedSelectionProjection,
  type HarnessRuntimeSelectionDeps,
} from '../sessionRuntimeHarnessSelection';
import { createSessionControlRuntimeWriter } from '../sessionControlRuntimeWriter';
import { clearAllSessionRuntimeControlStates, type SessionRuntimeProfile } from '../sessionRuntimeControl';

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
    stage: (id, profile, assertCurrent, beforeMutation, source = 'agent') =>
      performSessionAgentSwitch(switchDeps, {
        sessionId: id,
        targetAgentKind: profile.agentKind,
        model: profile.model,
        providerId: profile.providerId,
        effort: profile.effort,
        fastMode: profile.fastMode,
        ...(profile.agentDeviceId !== undefined ? { agentDeviceId: profile.agentDeviceId } : {}),
        runtimeSource: source === 'agent' ? 'agent' : undefined,
        assertSelectionCurrent: assertCurrent,
        beforeMutation,
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
  // The plugin task API now stages remote selections through this same production
  // controller. Previously its projection lost the source, hiding location-only changes.
  // Minimal pending relocation, including an explicit return to local; tier: unit.
  it.each(['other-computer', 'share:provider', null])('preserves location %s through staging and pending projection', async agentDeviceId => {
    const h = setup(true);
    if (agentDeviceId === null) {
      h.effective.agentDeviceId = 'original-computer';
      const row = await h.switchDeps.getSessionRow('s1');
      h.switchDeps.getSessionRow = vi.fn(async () => ({ ...row!, agentDeviceId: 'original-computer' }));
    }
    Object.assign(h.switchDeps, { assertAgentDeviceRouteUsable: vi.fn(async () => {}) });
    const result = await setSessionRuntimeHarness(h.deps, {
      ...request, patch: { ...request.patch, agentDeviceId },
    });
    expect(result).toMatchObject({ ok: true, status: 'deferred',
      pendingMutation: { profile: { agentDeviceId, agentKind: 'codex' } } });
    expect(h.close).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });
  it('keeps a configured default effort instead of inheriting the previous harness effort', async () => {
    const h = setup();
    const result = await setSessionRuntimeHarness(h.deps, {
      ...request, patch: { ...request.patch, effort: null },
    });
    expect(result).toMatchObject({
      ok: true,
      pendingMutation: { profile: { effort: null } },
    });
    expect(h.deps.resolve).toHaveBeenCalledWith(expect.objectContaining({ effort: null }), {
      effort: true, fast: false,
    });
  });

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

  // 2026-11-17: after staging a Worker's new source, the Lead's follow-up without harness hit
  // CONFLICT although its generation matched, because the turn-end path yields to any staged
  // selection. Without harness the patch now revises the staged selection, as choosing again in
  // the picker does; omitted fields keep the staged values. Tier: unit (real staging transaction).
  it('revises a staged selection when harness is omitted, keeping its other fields', async () => {
    const h = setup();
    await setSessionRuntimeHarness(h.deps, {
      ...request, patch: { ...request.patch, providerId: 'gateway', effort: 'low' },
    });

    expect(await setSessionRuntimeHarness(h.deps, {
      targetSessionId: 's1', expectedGeneration: 5, patch: { fastMode: true },
    })).toMatchObject({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      pendingMutation: {
        profile: { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'gateway', effort: 'low', fastMode: true },
      },
    });
    expect(h.close).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  // PR #11071: axes-only Agent revisions lost picker provenance. Existing tests only
  // revised Agent choices. Minimal input: reselect the current model, then enable Fast.
  // Unit tier: real staging + send application must retain the IM manual-route marker.
  it('keeps a user-staged choice manual after an Agent revises its axes and sends', async () => {
    const h = setup();
    h.pending.set('s1', {
      targetAgentKind: 'claude-code', model: h.effective.model,
      providerId: 'old-provider', sameAgentSelection: true,
    });
    h.switchDeps.selectSameAgentModel = vi.fn(async (id, intent, applyNow) => {
      if (!applyNow) h.pending.set(id, { ...intent, sameAgentSelection: true });
      return { deferred: !applyNow };
    });
    h.switchDeps.onUserRouteSelectionLanded = vi.fn(async () => {});

    expect(await setSessionRuntimeHarness(h.deps, {
      targetSessionId: 's1', expectedGeneration: 4, patch: { fastMode: true },
    })).toMatchObject({
      ok: true,
      pendingMutation: { source: 'user', profile: { fastMode: true } },
    });
    await applyPendingAgentSwitchIfIdle(h.switchDeps, 's1');
    expect(h.switchDeps.onUserRouteSelectionLanded).toHaveBeenCalledWith('s1');
    expect(h.pending.get('s1')).toBeUndefined();
  });

  // Agent runtime reads showed pending=null for a picker choice, so a Lead could overwrite a
  // choice it never saw. Picker choices project as source=user; system follow-ups and the
  // agent's own staging (already projected) do not. Tier: unit (the projection Host reads use).
  it.each([
    [{ targetAgentKind: 'codex' as const, model: 'gpt-6-astra', providerId: 'openai', sameAgentSelection: true }, 'user'],
    [{ targetAgentKind: 'codex' as const, model: 'gpt-6-astra', providerId: 'openai', runtimeSource: 'agent' as const }, null],
    [{ targetAgentKind: 'codex' as const, model: 'gpt-6-astra', providerId: 'openai', configStaged: true }, null],
  ])('projects only picker choices as user-staged: %j', (intent, source) => {
    expect(userStagedSelectionProjection(intent, 7, null)?.source ?? null).toBe(source);
    if (source) {
      expect(userStagedSelectionProjection(intent, 7, null)).toEqual({
        generation: 7, source: 'user',
        profile: { agentDeviceId: null, agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: null, fastMode: false },
      });
    }
  });

  it('asks to re-read when the staged selection a revision targets is gone', async () => {
    const h = setup();
    expect(await setSessionRuntimeHarness(h.deps, {
      ...request, patch: { model: 'gpt-6-astra' },
    })).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect(h.pending.get('s1')).toBeUndefined();
  });

  it.each([
    { orcaRole: 'lead', running: false },
    { orcaRole: 'lead', running: true },
    { orcaRole: 'worker', running: false },
    { orcaRole: 'worker', running: true },
  ])('stages an Orca harness choice until the next send: %j', async ({ orcaRole, running }) => {
    const h = setup(running);
    h.pending.set('s1', { targetAgentKind: 'pi', model: 'old-choice', providerId: null });
    const read = h.switchDeps.getSessionRow;
    h.switchDeps.getSessionRow = async (id) => ({ ...(await read(id))!, orcaRole });

    expect(await setSessionRuntimeHarness(h.deps, request)).toMatchObject({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      generation: 5,
      effectiveProfile: h.effective,
      pendingMutation: {
        source: 'agent',
        profile: { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' },
      },
    });
    expect(h.pending.get('s1')).toMatchObject({
      targetAgentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai',
    });
    expect(h.close).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it.each([
    { remoteHostId: 'ssh-host' },
    { remoteHostId: 'ssh-host', orcaRole: 'lead' },
    { remoteHostId: 'ssh-host', orcaRole: 'worker' },
    { source: 'review' },
    { status: 'deleted' },
    { status: 'archived' },
  ])('preserves existing intent when target is ineligible: %j', async (overrides) => {
    const h = setup();
    const previous = { targetAgentKind: 'pi' as const, model: 'old-choice', providerId: null };
    h.pending.set('s1', previous);
    const read = h.switchDeps.getSessionRow;
    h.switchDeps.getSessionRow = async (id) => ({ ...(await read(id))!, ...overrides });
    expect(await setSessionRuntimeHarness(h.deps, request)).toMatchObject({
      ok: false,
      errorCode: overrides.status === 'deleted' ? 'NOT_FOUND' : 'ROUTE_UNAVAILABLE',
    });
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

  // Value: switching provider_device_id without harness/model must keep the current engine & model,
  // drop the old computer's providerId (never inheriting it across devices), and map remote failures
  // to ROUTE_UNAVAILABLE instead of INTERNAL.
  // Gap: prior path pre-filled harness without model and rejected location-only switches with INVALID_ARGS,
  // and left REMOTE_AGENT_* unmapped.
  // Minimal input: location-only switch to another device, back to local, revision on staged choice, and remote error codes.
  // Tier: unit.
  it('supports location-only provider_device_id switches without harness or model and drops old device providerId', async () => {
    const h = setup();
    Object.assign(h.switchDeps, { assertAgentDeviceRouteUsable: vi.fn(async () => {}) });

    const moved = await setSessionRuntimeHarness(h.deps, {
      targetSessionId: 's1',
      expectedGeneration: 4,
      patch: { agentDeviceId: 'mac-studio' },
    });
    expect(moved).toMatchObject({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      pendingMutation: {
        source: 'agent',
        profile: {
          agentDeviceId: 'mac-studio',
          agentKind: 'claude-code',
          model: 'claude-fable-5',
          providerId: 'openai', // resolved by deps.resolve because old-provider was dropped to null
        },
      },
    });
    expect(h.deps.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDeviceId: 'mac-studio',
        agentKind: 'claude-code',
        model: 'claude-fable-5',
        providerId: null,
      }),
      { effort: false, fast: false },
    );

    // Moving a staged choice to another computer keeps the staged harness/model and clears the old computer's providerId.
    const movedAgain = await setSessionRuntimeHarness(h.deps, {
      targetSessionId: 's1',
      expectedGeneration: 5,
      patch: { agentDeviceId: 'share:team-1', providerId: 'gateway' },
    });
    expect(movedAgain).toMatchObject({
      ok: true,
      pendingMutation: {
        profile: {
          agentDeviceId: 'share:team-1',
          agentKind: 'claude-code',
          model: 'claude-fable-5',
          providerId: 'gateway',
        },
      },
    });
  });

  it.each([
    'REMOTE_AGENT_DEVICE_UNREACHABLE',
    'REMOTE_AGENT_MODEL_UNAVAILABLE',
    'REMOTE_AGENT_SHARE_PAUSED',
    'REMOTE_AGENT_SHARE_REMOVED',
    'PRECONDITION_FAILED',
    'MODEL_SELECTION_UNAVAILABLE',
  ])('maps %s to ROUTE_UNAVAILABLE instead of throwing INTERNAL', async (code) => {
    const h = setup();
    h.deps.resolve = async () => {
      throw Object.assign(new Error(`failed with ${code}`), { code });
    };
    expect(await setSessionRuntimeHarness(h.deps, {
      targetSessionId: 's1',
      expectedGeneration: 4,
      patch: { agentDeviceId: 'mac-studio' },
    })).toMatchObject({
      ok: false,
      errorCode: 'ROUTE_UNAVAILABLE',
      message: `failed with ${code}`,
    });
  });

  // Value: writer normalizes selfDeviceId -> null and triggers onExplicitRouteSelected only after
  // an accepted route/device mutation (never on rejected attempts or effort-only patches).
  // Gap: prior writer lacked selfDeviceId normalization and left stale usage-limit waits alive.
  // Minimal input: writer called with self device ID, conflict attempt, and effort-only update; tier: unit.
  it('normalizes selfDeviceId to local and notifies onExplicitRouteSelected only on accepted route changes', async () => {
    clearAllSessionRuntimeControlStates();
    const pending = createPendingAgentSwitchRegistry();
    const onExplicitRouteSelected = vi.fn();
    const updateScheduledPreference = vi.fn(async () => true);
    const acceptTaskChoice = vi.fn(async () => {});
    const effective: SessionRuntimeProfile = {
      agentDeviceId: 'mac-studio',
      agentKind: 'codex',
      model: 'gpt-6-astra',
      providerId: 'remote-prov',
      effort: 'high',
      fastMode: false,
    };
    const switchDeps = {
      getSessionRow: vi.fn(async () => ({
        id: 'writer-s1',
        agentKind: 'codex',
        agentDeviceId: 'mac-studio',
        model: effective.model,
        providerId: 'remote-prov',
        status: 'active',
        remoteHostId: null,
        orcaRole: null,
        sdkSessionId: 'native-1',
      })),
      getLiveSession: () => ({ isTurnRunning: () => false }),
      pendingSwitches: pending,
      onPendingSwitchChanged: vi.fn(),
      closeSession: vi.fn(),
      applyAgentSwitchToDb: vi.fn(),
      supersedePendingCredentialSwitch: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    } as unknown as MakerSessionAgentSwitchHandlerDeps;
    const providerView = {
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
      connected: true,
      agents: ['codex'],
      auth: { method: 'none' },
      routing: { codex: { wireProtocol: 'openai-responses' } },
      models: {
        codex: [{ id: 'gpt-6-astra', name: 'GPT-6', contextWindow: 128_000, efforts: ['low', 'high'], defaultEffort: 'high', supportsFastMode: true }],
      },
    };
    const writer = createSessionControlRuntimeWriter({
      agentSwitchPending: pending,
      agentSwitchDeps: switchDeps,
      assertModelRouteUsable: vi.fn(async () => undefined),
      getDesktopProviderService: () => ({ listProviders: vi.fn(async () => [providerView] as never) }),
      reconcileBotModelRoute: { acceptTaskChoice },
      updateScheduledPreference,
      readSessionRuntimeProfiles: vi.fn(async () => ({
        baseline: effective,
        effective,
        control: { generation: 0, effectiveOverride: null, pending: null, fallbackHop: 0, visitedRoutes: [], lastRouteChange: null },
        pendingMutation: null,
      })),
      readUsableAgentDeviceProviders: vi.fn(async () => [providerView] as never),
      shouldApplyExclusiveProviderRerouteLive: () => false,
      applySessionRuntimeSelection: vi.fn(async () => ({ deferred: false, superseded: false, generation: 1 })),
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
      isSelfDeviceId: (id) => id === 'self-mac',
      onExplicitRouteSelected,
    });

    // Stale generation conflict must not cancel recovery waits.
    expect(await writer({
      targetSessionId: 'writer-s1',
      expectedGeneration: 99,
      patch: { agentDeviceId: 'self-mac' },
    })).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect(onExplicitRouteSelected).not.toHaveBeenCalled();

    // Effort-only adjustment must not trigger onExplicitRouteSelected.
    expect(await writer({
      targetSessionId: 'writer-s1',
      expectedGeneration: 0,
      patch: { effort: 'low' },
    })).toMatchObject({ ok: true, status: 'applied' });
    expect(onExplicitRouteSelected).not.toHaveBeenCalled();

    // Passing self-mac normalizes to agentDeviceId: null and triggers onExplicitRouteSelected.
    const movedLocal = await writer({
      targetSessionId: 'writer-s1',
      expectedGeneration: 0,
      patch: { agentDeviceId: 'self-mac' },
    });
    expect(movedLocal).toMatchObject({
      ok: true,
      status: 'deferred',
      effectiveBoundary: 'next_send',
      pendingMutation: { profile: { agentDeviceId: null, agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' } },
    });
    expect(onExplicitRouteSelected).toHaveBeenCalledTimes(1);
    expect(onExplicitRouteSelected).toHaveBeenCalledWith('writer-s1');
    clearAllSessionRuntimeControlStates();
  });
});
