import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  acceptSessionRuntimeAxisMutation,
  acceptSessionRuntimeMutation,
  cancelPendingSessionRuntimeMutation,
  captureSessionRuntimeControlOwnerEpoch,
  clearAllSessionRuntimeControlStates,
  clearSessionRuntimeControlState,
  deferSessionRuntimeAxisMutation,
  getSessionRuntimeControlSnapshot,
  isPendingSessionRuntimeRouteExplicit,
  mergeSessionRuntimeProfilePatch,
  pickSessionRuntimeFallback,
  recordFailedSessionRuntimeFallbackCandidate,
  recordRecoveredSessionRuntimeMutation,
  recordRecoveredSessionRuntimeAxisMutation,
  recordUserSessionRuntimeAxisMutation,
  recordUserSessionRuntimeMutation,
  resolveCompatibleSessionRuntimeAxisPatch,
  resolveSessionRuntimeAxes,
  sessionRuntimeControlOwnerEpochMatches,
  sessionRuntimeGenerationMatches,
  settlePendingSessionRuntimeMutation,
  type SessionRuntimeProfile,
} from '../sessionRuntimeControl.js';

afterEach(() => {
  clearAllSessionRuntimeControlStates();
});

const current: SessionRuntimeProfile = {
  agentKind: 'codex',
  model: 'gpt-main',
  providerId: 'openai',
  effort: 'high',
  fastMode: true,
};

function provider(
  id: string,
  models: Array<{
    id: string;
    defaults?: boolean;
    efforts?: SessionRuntimeProfile['effort'][];
    fast?: boolean;
    group?: string;
    mode?: string;
  }>,
  source: 'builtin' | 'user' = 'builtin',
): ProviderView {
  return {
    id,
    name: id,
    source,
    connected: true,
    agents: ['codex'],
    auth: { method: 'none' },
    routing: { codex: { wireProtocol: 'openai-responses' } },
    models: {
      codex: models.map((model) => ({
        id: model.id,
        name: model.id,
        contextWindow: 100_000,
        efforts: (model.efforts ?? ['medium']) as never,
        defaultEffort: (model.efforts?.[0] ?? 'medium') as never,
        supportsFastMode: model.fast,
        ...(model.group ? { group: model.group } : {}),
        ...(model.mode ? { mode: model.mode } : {}),
        ...(model.defaults ? { newSessionDefault: ['codex'] } : {}),
      })),
    },
  } as unknown as ProviderView;
}

describe('session runtime control state', () => {
  it('uses one monotonic generation for deferred and settled mutations', () => {
    const sessionId = 'runtime-generation';
    expect(sessionRuntimeGenerationMatches(sessionId, 0)).toBe(true);
    const generation = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: current,
      deferred: true,
    });
    expect(generation).toBe(1);
    expect(settlePendingSessionRuntimeMutation(sessionId, generation)).toBe(true);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation: 1,
      pending: null,
      effectiveOverride: current,
    });
  });

  it('a user selection invalidates pending and fallback state', () => {
    const sessionId = 'runtime-user-wins';
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'fallback',
      profile: current,
      deferred: true,
    });
    const generation = recordUserSessionRuntimeMutation(sessionId);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      pending: null,
      effectiveOverride: null,
      fallbackHop: 0,
      visitedRoutes: [],
    });
  });

  it('rejects a stale generation after a newer user mutation', () => {
    const sessionId = 'runtime-stale-generation';
    const observed = getSessionRuntimeControlSnapshot(sessionId).generation;
    recordUserSessionRuntimeMutation(sessionId);
    expect(sessionRuntimeGenerationMatches(sessionId, observed)).toBe(false);
  });

  it('a user effort change keeps an active temporary route but invalidates fallback progress', () => {
    const sessionId = 'runtime-user-axis';
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'fallback',
      profile: current,
      deferred: false,
    });
    recordUserSessionRuntimeAxisMutation(sessionId, { effort: 'max' });
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      effectiveOverride: { ...current, effort: 'max' },
      pending: null,
      fallbackHop: 0,
      visitedRoutes: [],
    });
  });

  it('preserves a deferred route when a user changes one runtime axis', () => {
    const sessionId = 'runtime-user-axis-pending';
    const pending = { ...current, model: 'gpt-next', providerId: 'xd', fastMode: false };
    const firstGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });

    const secondGeneration = recordUserSessionRuntimeAxisMutation(sessionId, {
      fastMode: true,
    });

    expect(secondGeneration).toBe(firstGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation: secondGeneration,
      effectiveOverride: null,
      pending: {
        generation: secondGeneration,
        source: 'agent',
        profile: { ...pending, fastMode: true },
      },
      fallbackHop: 0,
      visitedRoutes: [],
    });
  });

  it('applies an Agent axis patch without replacing its accepted pending route', () => {
    const sessionId = 'runtime-agent-axis-pending';
    const live = { ...current, model: 'gpt-live' };
    const pending = { ...current, model: 'gpt-next', providerId: 'xd', fastMode: false };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: live,
      deferred: false,
    });
    const pendingGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });

    const generation = acceptSessionRuntimeAxisMutation({
      sessionId,
      source: 'agent',
      profile: { ...live, effort: 'max' },
      pendingPatch: { effort: 'max' },
    });

    expect(generation).toBe(pendingGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: { ...live, effort: 'max' },
      pending: {
        generation,
        source: 'agent',
        profile: { ...pending, effort: 'max' },
      },
    });
    expect(isPendingSessionRuntimeRouteExplicit(sessionId, generation)).toBe(true);
  });

  it('records an Agent axis-only override when the live profile started from baseline', () => {
    const generation = acceptSessionRuntimeAxisMutation({
      sessionId: 'runtime-agent-axis-baseline',
      source: 'agent',
      profile: { ...current, effort: 'max' },
      pendingPatch: { effort: 'max' },
    });

    expect(getSessionRuntimeControlSnapshot('runtime-agent-axis-baseline')).toMatchObject({
      generation,
      effectiveOverride: { ...current, effort: 'max' },
      pending: null,
    });
  });

  it('defers an Agent axis-only patch without changing the busy live profile', () => {
    const sessionId = 'runtime-agent-axis-busy';
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: current,
      deferred: false,
    });

    const generation = deferSessionRuntimeAxisMutation({
      sessionId,
      source: 'agent',
      effectiveProfile: current,
      pendingPatch: { effort: 'max' },
    });

    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: current,
      pending: {
        generation,
        source: 'agent',
        profile: { ...current, effort: 'max' },
      },
    });
    expect(isPendingSessionRuntimeRouteExplicit(sessionId, generation)).toBe(false);
  });

  it('patches an accepted deferred route while keeping the effective route unchanged', () => {
    const sessionId = 'runtime-agent-axis-busy-with-route';
    const effective = { ...current, model: 'gpt-live', providerId: 'openai' };
    const pending = { ...current, model: 'gpt-next', providerId: 'xd', fastMode: false };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: effective,
      deferred: false,
    });
    const pendingGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });

    const generation = deferSessionRuntimeAxisMutation({
      sessionId,
      source: 'agent',
      effectiveProfile: effective,
      pendingPatch: { effort: 'max' },
    });

    expect(generation).toBe(pendingGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: effective,
      pending: {
        generation,
        source: 'agent',
        profile: { ...pending, effort: 'max' },
      },
    });
    expect(isPendingSessionRuntimeRouteExplicit(sessionId, generation)).toBe(true);
  });

  it('updates the live override and deferred route when a user changes one runtime axis', () => {
    const sessionId = 'runtime-user-axis-effective-and-pending';
    const effective = { ...current, model: 'gpt-live', providerId: 'openai' };
    const pending = { ...current, model: 'gpt-next', providerId: 'xd', fastMode: false };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: effective,
      deferred: false,
    });
    const pendingGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });

    const generation = recordUserSessionRuntimeAxisMutation(sessionId, {
      fastMode: true,
      effort: 'max',
    });

    expect(generation).toBe(pendingGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: { ...effective, fastMode: true, effort: 'max' },
      pending: {
        generation,
        source: 'agent',
        profile: { ...pending, fastMode: true, effort: 'max' },
      },
    });
  });

  it('keeps pending axes compatible while applying the user patch to the live override', () => {
    const sessionId = 'runtime-user-axis-incompatible-pending';
    const effective = { ...current, model: 'gpt-live' };
    const pending = {
      ...current,
      model: 'gpt-fixed',
      providerId: 'xd',
      effort: null,
      fastMode: false,
    };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: effective,
      deferred: false,
    });
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });

    recordUserSessionRuntimeAxisMutation(
      sessionId,
      { effort: 'ultra', fastMode: true },
      { effort: null, fastMode: false },
    );

    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      effectiveOverride: { ...effective, effort: 'ultra', fastMode: true },
      pending: { profile: pending },
    });
  });

  it('cancels only the unchanged pending generation after settlement fails', () => {
    const sessionId = 'runtime-cancel-pending';
    const effective = { ...current, model: 'gpt-live' };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: effective,
      deferred: false,
    });
    const generation = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: { ...current, model: 'gpt-next' },
      deferred: true,
    });

    expect(cancelPendingSessionRuntimeMutation(sessionId, generation - 1)).toBe(false);
    expect(cancelPendingSessionRuntimeMutation(sessionId, generation)).toBe(true);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: effective,
      pending: null,
    });
    expect(cancelPendingSessionRuntimeMutation('runtime-missing', 0)).toBe(false);
    expect(getSessionRuntimeControlSnapshot('runtime-missing')).toMatchObject({
      generation: 0,
      effectiveOverride: null,
      pending: null,
    });
  });

  it('records an unavoidable live profile after persistence recovery fails', () => {
    const sessionId = 'runtime-persistence-recovery';
    const observedGeneration = getSessionRuntimeControlSnapshot(sessionId).generation;
    const generation = recordRecoveredSessionRuntimeMutation(sessionId, current);

    expect(generation).toBe(observedGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: current,
      pending: null,
      fallbackHop: 0,
      visitedRoutes: [],
    });
    expect(sessionRuntimeGenerationMatches(sessionId, observedGeneration)).toBe(false);
  });

  it('records an unavoidable live axis while preserving a deferred route', () => {
    const sessionId = 'runtime-axis-recovery';
    const pending = { ...current, model: 'gpt-next', providerId: 'xd' };
    const pendingGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });
    const live = { ...current, effort: 'high' as const };

    const generation = recordRecoveredSessionRuntimeAxisMutation(sessionId, live);

    expect(generation).toBe(pendingGeneration + 1);
    expect(getSessionRuntimeControlSnapshot(sessionId)).toMatchObject({
      generation,
      effectiveOverride: live,
      pending: { generation, source: 'agent', profile: pending },
    });
  });

  it('clears one terminal session without disturbing another runtime override', () => {
    acceptSessionRuntimeMutation({
      sessionId: 'runtime-clear-one',
      source: 'agent',
      profile: current,
      deferred: false,
    });
    acceptSessionRuntimeMutation({
      sessionId: 'runtime-keep-one',
      source: 'agent',
      profile: { ...current, model: 'gpt-other' },
      deferred: false,
    });

    clearSessionRuntimeControlState('runtime-clear-one');

    expect(getSessionRuntimeControlSnapshot('runtime-clear-one')).toMatchObject({
      generation: 0,
      effectiveOverride: null,
      pending: null,
    });
    expect(getSessionRuntimeControlSnapshot('runtime-keep-one').effectiveOverride).toMatchObject({
      model: 'gpt-other',
    });
  });

  it('clears every runtime override at an account boundary', () => {
    const previousOwnerEpoch = captureSessionRuntimeControlOwnerEpoch();
    acceptSessionRuntimeMutation({
      sessionId: 'runtime-owner-a',
      source: 'agent',
      profile: current,
      deferred: true,
    });
    acceptSessionRuntimeMutation({
      sessionId: 'runtime-owner-b',
      source: 'fallback',
      profile: { ...current, providerId: 'xd' },
      deferred: false,
    });

    clearAllSessionRuntimeControlStates();

    expect(getSessionRuntimeControlSnapshot('runtime-owner-a').generation).toBe(0);
    expect(getSessionRuntimeControlSnapshot('runtime-owner-b').generation).toBe(0);
    expect(sessionRuntimeControlOwnerEpochMatches(previousOwnerEpoch)).toBe(false);
    expect(sessionRuntimeControlOwnerEpochMatches(captureSessionRuntimeControlOwnerEpoch())).toBe(
      true,
    );
  });

  it('preserves null effort in a deferred fixed-effort switch', () => {
    const generation = acceptSessionRuntimeMutation({
      sessionId: 'runtime-fixed-effort',
      source: 'agent',
      profile: { ...current, effort: null },
      deferred: true,
    });

    expect(getSessionRuntimeControlSnapshot('runtime-fixed-effort').pending).toEqual({
      generation,
      source: 'agent',
      profile: { ...current, effort: null },
    });
  });

  it('composes a later partial patch on the already accepted pending profile', () => {
    const sessionId = 'runtime-compose-pending';
    const pending = { ...current, model: 'gpt-next', providerId: 'xd', fastMode: false };
    const firstGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: pending,
      deferred: true,
    });
    const firstSnapshot = getSessionRuntimeControlSnapshot(sessionId);
    expect(firstSnapshot.pending?.generation).toBe(firstGeneration);

    const composed = mergeSessionRuntimeProfilePatch(firstSnapshot.pending!.profile, {
      fastMode: true,
    });
    const secondGeneration = acceptSessionRuntimeMutation({
      sessionId,
      source: 'agent',
      profile: composed,
      deferred: true,
    });
    expect(secondGeneration).toBe(firstGeneration + 1);
    expect(settlePendingSessionRuntimeMutation(sessionId, secondGeneration)).toBe(true);
    expect(getSessionRuntimeControlSnapshot(sessionId).effectiveOverride).toEqual({
      ...pending,
      fastMode: true,
    });
  });
});

describe('session runtime fallback selection', () => {
  it('normalizes a user axis patch against the pending target capabilities', () => {
    const fixed = provider('xd', [
      { id: 'gpt-fixed', efforts: [], fast: false },
    ]).models.codex![0]!;
    expect(
      resolveCompatibleSessionRuntimeAxisPatch({
        model: fixed,
        profile: { ...current, model: 'gpt-fixed', effort: null, fastMode: false },
        patch: { effort: 'ultra', fastMode: true },
      }),
    ).toEqual({ effort: null, fastMode: false });
  });

  it('skips a failed candidate without consuming a fallback hop or generation', () => {
    const sessionId = 'runtime-failed-candidate';
    const candidate = { ...current, providerId: 'xd' };
    const observed = getSessionRuntimeControlSnapshot(sessionId);

    expect(
      recordFailedSessionRuntimeFallbackCandidate(sessionId, observed.generation, candidate),
    ).toBe(true);
    const afterFailure = getSessionRuntimeControlSnapshot(sessionId);
    expect(afterFailure).toMatchObject({
      generation: observed.generation,
      fallbackHop: observed.fallbackHop,
      visitedRoutes: ['xd\u0000gpt-main'],
    });

    expect(
      pickSessionRuntimeFallback({
        providers: [
          provider('openai', [{ id: 'gpt-main' }]),
          provider('xd', [{ id: 'gpt-main' }]),
          provider('other', [{ id: 'gpt-main' }]),
        ],
        current,
        visitedRoutes: afterFailure.visitedRoutes,
        currentHop: afterFailure.fallbackHop,
        maxHops: 2,
      }),
    ).toMatchObject({ providerId: 'other', model: 'gpt-main' });
  });

  it('does not record a failed candidate against a stale generation', () => {
    const sessionId = 'runtime-stale-failed-candidate';
    const observed = getSessionRuntimeControlSnapshot(sessionId).generation;
    recordUserSessionRuntimeMutation(sessionId);

    expect(
      recordFailedSessionRuntimeFallbackCandidate(sessionId, observed, {
        ...current,
        providerId: 'xd',
      }),
    ).toBe(false);
    expect(getSessionRuntimeControlSnapshot(sessionId).visitedRoutes).toEqual([]);
  });

  it('rejects explicit unsupported axes and normalizes inherited axes', () => {
    const model = provider('xd', [
      { id: 'gpt-main', efforts: ['medium'], fast: false },
    ]).models.codex![0]!;
    const fixedEffortModel = provider('xd', [
      { id: 'gpt-fixed', efforts: [], fast: false },
    ]).models.codex![0]!;
    expect(
      resolveSessionRuntimeAxes({
        model,
        effort: 'ultra',
        fastMode: false,
        effortExplicit: true,
        fastExplicit: false,
      }),
    ).toEqual({ ok: false, reason: 'effort-unavailable' });
    expect(
      resolveSessionRuntimeAxes({
        model,
        effort: 'high',
        fastMode: true,
        effortExplicit: false,
        fastExplicit: false,
      }),
    ).toEqual({ ok: true, effort: 'medium', fastMode: false });
    expect(
      resolveSessionRuntimeAxes({
        model: fixedEffortModel,
        effort: 'low',
        fastMode: false,
        effortExplicit: true,
        fastExplicit: false,
      }),
    ).toEqual({ ok: false, reason: 'effort-unavailable' });
    expect(
      resolveSessionRuntimeAxes({
        model: fixedEffortModel,
        effort: 'low',
        fastMode: false,
        effortExplicit: true,
        fastExplicit: false,
        allowFixedEffortPlaceholder: true,
      }),
    ).toEqual({ ok: true, effort: null, fastMode: false });
  });

  it('prefers the same model on another connected source', () => {
    const result = pickSessionRuntimeFallback({
      providers: [
        provider('openai', [{ id: 'gpt-main' }]),
        provider('xd', [{ id: 'gpt-main', efforts: ['medium'], fast: false }]),
        provider('other', [{ id: 'recommended', defaults: true }]),
      ],
      current,
      visitedRoutes: [],
      currentHop: 0,
      maxHops: 2,
    });
    expect(result).toMatchObject({
      providerId: 'xd',
      model: 'gpt-main',
      effort: 'medium',
      fastMode: false,
    });
  });

  it('ignores disconnected sources even when they offer the same model', () => {
    const disconnected = provider('disconnected', [{ id: 'gpt-main' }]);
    disconnected.connected = false;
    expect(
      pickSessionRuntimeFallback({
        providers: [provider('openai', [{ id: 'gpt-main' }]), disconnected],
        current,
        visitedRoutes: [],
        currentHop: 0,
        maxHops: 2,
      }),
    ).toBeNull();
  });

  it('uses only an explicitly declared same-harness default after exact-name routes', () => {
    const providers = [
      provider('openai', [{ id: 'gpt-main' }]),
      provider('xd', [{ id: 'arbitrary-first' }, { id: 'recommended', defaults: true }]),
    ];
    expect(
      pickSessionRuntimeFallback({
        providers,
        current,
        visitedRoutes: [],
        currentHop: 0,
        maxHops: 2,
      }),
    ).toMatchObject({ providerId: 'xd', model: 'recommended' });
  });

  it('skips non-chat exact-name and default candidates before later usable routes', () => {
    expect(
      pickSessionRuntimeFallback({
        providers: [
          provider('openai', [{ id: 'gpt-main' }]),
          provider('image-copy', [{ id: 'gpt-main', mode: 'image_generation' }]),
          provider('chat-copy', [{ id: 'gpt-main' }]),
        ],
        current,
        visitedRoutes: [],
        currentHop: 0,
        maxHops: 2,
      }),
    ).toMatchObject({ providerId: 'chat-copy', model: 'gpt-main' });

    expect(
      pickSessionRuntimeFallback({
        providers: [
          provider('openai', [{ id: 'gpt-main' }]),
          provider('image-default', [
            { id: 'image-recommended', defaults: true, mode: 'image_generation' },
          ]),
          provider('chat-default', [{ id: 'chat-recommended', defaults: true }]),
        ],
        current: { ...current, model: 'missing-model' },
        visitedRoutes: [],
        currentHop: 0,
        maxHops: 2,
      }),
    ).toMatchObject({ providerId: 'chat-default', model: 'chat-recommended' });
  });

  it('keeps custom-group models selectable for a user provider', () => {
    expect(
      pickSessionRuntimeFallback({
        providers: [
          provider('openai', [{ id: 'gpt-main' }]),
          provider(
            'custom',
            [{ id: 'gpt-image-custom', defaults: true, group: 'custom:custom' }],
            'user',
          ),
        ],
        current: { ...current, model: 'missing-model' },
        visitedRoutes: [],
        currentHop: 0,
        maxHops: 2,
      }),
    ).toMatchObject({ providerId: 'custom', model: 'gpt-image-custom' });
  });

  it('stops at the hop limit and never revisits a route', () => {
    const providers = [provider('xd', [{ id: 'gpt-main' }])];
    expect(
      pickSessionRuntimeFallback({
        providers,
        current,
        visitedRoutes: ['xd\u0000gpt-main'],
        currentHop: 1,
        maxHops: 2,
      }),
    ).toBeNull();
    expect(
      pickSessionRuntimeFallback({
        providers,
        current,
        visitedRoutes: [],
        currentHop: 2,
        maxHops: 2,
      }),
    ).toBeNull();
  });

  it('persists the route being left so fallback cannot bounce A to B to A', () => {
    const sessionId = 'runtime-no-bounce';
    const next = { ...current, providerId: 'xd' };
    acceptSessionRuntimeMutation({
      sessionId,
      source: 'fallback',
      previousProfile: current,
      profile: next,
      deferred: false,
    });
    const state = getSessionRuntimeControlSnapshot(sessionId);
    expect(state.visitedRoutes).toEqual(
      expect.arrayContaining(['openai\u0000gpt-main', 'xd\u0000gpt-main']),
    );
    expect(
      pickSessionRuntimeFallback({
        providers: [provider('openai', [{ id: 'gpt-main' }])],
        current: next,
        visitedRoutes: state.visitedRoutes,
        currentHop: state.fallbackHop,
        maxHops: 2,
      }),
    ).toBeNull();
  });
});
