import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  acceptSessionRuntimeMutation,
  captureSessionRuntimeControlOwnerEpoch,
  clearAllSessionRuntimeControlStates,
  clearSessionRuntimeControlState,
  getSessionRuntimeControlSnapshot,
  mergeSessionRuntimeProfilePatch,
  pickSessionRuntimeFallback,
  recordRecoveredSessionRuntimeMutation,
  recordRecoveredSessionRuntimeAxisMutation,
  recordUserSessionRuntimeAxisMutation,
  recordUserSessionRuntimeMutation,
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
  it('rejects explicit unsupported axes and normalizes inherited axes', () => {
    const model = provider('xd', [
      { id: 'gpt-main', efforts: ['medium'], fast: false },
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
