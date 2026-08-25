import type { AgentKind, Effort } from '@cindy/maker-core';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

export type SessionRuntimeMutationSource = 'agent' | 'fallback';

export interface SessionRuntimeProfile {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean;
}

export interface PendingSessionRuntimeMutation {
  generation: number;
  source: SessionRuntimeMutationSource;
  profile: SessionRuntimeProfile;
}

export interface SessionRuntimeControlSnapshot {
  generation: number;
  effectiveOverride: SessionRuntimeProfile | null;
  pending: PendingSessionRuntimeMutation | null;
  fallbackHop: number;
  visitedRoutes: string[];
}

export type SessionRuntimeProfilePatch = Partial<
  Pick<SessionRuntimeProfile, 'model' | 'providerId' | 'effort' | 'fastMode'>
>;

export type SessionRuntimeAxisPatch = Pick<
  Partial<SessionRuntimeProfile>,
  'effort' | 'fastMode'
>;

export function mergeSessionRuntimeProfilePatch(
  base: SessionRuntimeProfile,
  patch: SessionRuntimeProfilePatch,
): SessionRuntimeProfile {
  return {
    ...base,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}),
  };
}

interface SessionRuntimeControlState {
  generation: number;
  effectiveOverride: SessionRuntimeProfile | null;
  pending: PendingSessionRuntimeMutation | null;
  pendingRouteExplicit: boolean;
  fallbackHop: number;
  visitedRoutes: Set<string>;
}

const states = new Map<string, SessionRuntimeControlState>();
let ownerEpoch = 0;

function routeKey(profile: Pick<SessionRuntimeProfile, 'providerId' | 'model'>): string {
  return `${profile.providerId ?? ''}\u0000${profile.model}`;
}

function stateFor(sessionId: string): SessionRuntimeControlState {
  let state = states.get(sessionId);
  if (!state) {
    state = {
      generation: 0,
      effectiveOverride: null,
      pending: null,
      pendingRouteExplicit: true,
      fallbackHop: 0,
      visitedRoutes: new Set(),
    };
    states.set(sessionId, state);
  }
  return state;
}

export function sessionRuntimeGenerationMatches(
  sessionId: string,
  expectedGeneration: number | undefined,
): boolean {
  return expectedGeneration === undefined || (states.get(sessionId)?.generation ?? 0) === expectedGeneration;
}

export function recordUserSessionRuntimeMutation(sessionId: string): number {
  const state = stateFor(sessionId);
  state.generation += 1;
  state.effectiveOverride = null;
  state.pending = null;
  state.pendingRouteExplicit = true;
  state.fallbackHop = 0;
  state.visitedRoutes.clear();
  return state.generation;
}

/**
 * Persistence failed after the live Session had already switched, and the
 * compensating close could not retire it. Keep that unavoidable live profile
 * explicit so readers and CAS do not continue from the stale DB baseline.
 */
export function recordRecoveredSessionRuntimeMutation(
  sessionId: string,
  profile: SessionRuntimeProfile,
): number {
  const state = stateFor(sessionId);
  state.generation += 1;
  state.effectiveOverride = profile;
  state.pending = null;
  state.pendingRouteExplicit = true;
  state.fallbackHop = 0;
  state.visitedRoutes.clear();
  return state.generation;
}

/**
 * A user axis RPC reached the live Session but its baseline persistence and
 * compensating close both failed. Keep the observed live profile explicit while
 * preserving any earlier accepted deferred route.
 */
export function recordRecoveredSessionRuntimeAxisMutation(
  sessionId: string,
  profile: SessionRuntimeProfile,
): number {
  const state = stateFor(sessionId);
  state.generation += 1;
  state.effectiveOverride = profile;
  if (state.pending) {
    state.pending = { ...state.pending, generation: state.generation };
  }
  return state.generation;
}

export function recordUserSessionRuntimeAxisMutation(
  sessionId: string,
  patch: SessionRuntimeAxisPatch,
  pendingPatch: SessionRuntimeAxisPatch = patch,
): number {
  const state = stateFor(sessionId);
  state.generation += 1;
  const pending = state.pending;
  state.pending = pending
    ? {
        ...pending,
        generation: state.generation,
        profile: { ...pending.profile, ...pendingPatch },
      }
    : null;
  state.fallbackHop = 0;
  state.visitedRoutes.clear();
  if (state.effectiveOverride) {
    state.effectiveOverride = { ...state.effectiveOverride, ...patch };
  }
  return state.generation;
}

/**
 * Agent axis-only patches share the CAS/generation contract with model changes,
 * but must not route, persist a baseline, or cancel an already accepted route.
 */
export function acceptSessionRuntimeAxisMutation(params: {
  sessionId: string;
  source: SessionRuntimeMutationSource;
  profile: SessionRuntimeProfile;
  pendingPatch: SessionRuntimeAxisPatch;
}): number {
  const state = stateFor(params.sessionId);
  state.generation += 1;
  state.effectiveOverride = params.profile;
  if (state.pending) {
    state.pending = {
      ...state.pending,
      generation: state.generation,
      profile: { ...state.pending.profile, ...params.pendingPatch },
    };
  }
  if (params.source === 'agent') {
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
  }
  return state.generation;
}

/**
 * A busy task must leave its current turn untouched. Queue an Agent axis-only
 * patch at the same boundary as route changes, preserving any route that was
 * already accepted for that boundary and leaving the effective profile intact.
 */
export function deferSessionRuntimeAxisMutation(params: {
  sessionId: string;
  source: SessionRuntimeMutationSource;
  effectiveProfile: SessionRuntimeProfile;
  pendingPatch: SessionRuntimeAxisPatch;
}): number {
  const state = stateFor(params.sessionId);
  const hadPendingMutation = state.pending !== null;
  state.generation += 1;
  state.pending = state.pending
    ? {
        ...state.pending,
        generation: state.generation,
        profile: { ...state.pending.profile, ...params.pendingPatch },
      }
    : {
        generation: state.generation,
        source: params.source,
        profile: { ...params.effectiveProfile, ...params.pendingPatch },
      };
  if (!hadPendingMutation) state.pendingRouteExplicit = false;
  if (params.source === 'agent') {
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
  }
  return state.generation;
}

export function resolveCompatibleSessionRuntimeAxisPatch(params: {
  model: CatalogModel;
  profile: SessionRuntimeProfile;
  patch: SessionRuntimeAxisPatch;
}): SessionRuntimeAxisPatch {
  const axes = resolveSessionRuntimeAxes({
    model: params.model,
    effort:
      params.patch.effort !== undefined
        ? params.patch.effort
        : params.profile.effort,
    fastMode: params.patch.fastMode ?? params.profile.fastMode,
    effortExplicit: false,
    fastExplicit: false,
  });
  if (!axes.ok) return {};
  return {
    ...(params.patch.effort !== undefined ? { effort: axes.effort } : {}),
    ...(params.patch.fastMode !== undefined ? { fastMode: axes.fastMode } : {}),
  };
}

export function acceptSessionRuntimeMutation(params: {
  sessionId: string;
  source: SessionRuntimeMutationSource;
  profile: SessionRuntimeProfile;
  previousProfile?: SessionRuntimeProfile;
  deferred: boolean;
}): number {
  const state = stateFor(params.sessionId);
  state.generation += 1;
  const accepted: PendingSessionRuntimeMutation = {
    generation: state.generation,
    source: params.source,
    profile: params.profile,
  };
  state.pending = params.deferred ? accepted : null;
  state.pendingRouteExplicit = true;
  if (!params.deferred) state.effectiveOverride = params.profile;
  if (params.source === 'fallback') {
    state.fallbackHop += 1;
    if (params.previousProfile) state.visitedRoutes.add(routeKey(params.previousProfile));
    state.visitedRoutes.add(routeKey(params.profile));
  } else {
    state.fallbackHop = 0;
    state.visitedRoutes.clear();
  }
  return state.generation;
}

export function recordFailedSessionRuntimeFallbackCandidate(
  sessionId: string,
  expectedGeneration: number,
  profile: SessionRuntimeProfile,
): boolean {
  const state = stateFor(sessionId);
  if (state.generation !== expectedGeneration) return false;
  state.visitedRoutes.add(routeKey(profile));
  return true;
}

export function settlePendingSessionRuntimeMutation(
  sessionId: string,
  generation: number,
): boolean {
  const state = stateFor(sessionId);
  const pending = state.pending;
  if (!pending || pending.generation !== generation || state.generation !== generation)
    return false;
  state.pending = null;
  state.pendingRouteExplicit = true;
  state.effectiveOverride = pending.profile;
  return true;
}

export function cancelPendingSessionRuntimeMutation(
  sessionId: string,
  generation: number,
): boolean {
  const state = states.get(sessionId);
  const pending = state?.pending;
  if (!state || !pending || pending.generation !== generation || state.generation !== generation) {
    return false;
  }
  state.pending = null;
  state.pendingRouteExplicit = true;
  return true;
}

export function isPendingSessionRuntimeRouteExplicit(
  sessionId: string,
  generation: number,
): boolean {
  const state = states.get(sessionId);
  if (!state?.pending || state.pending.generation !== generation) return true;
  return state.pendingRouteExplicit;
}

export function getPendingSessionRuntimeMutation(
  sessionId: string,
): PendingSessionRuntimeMutation | null {
  return states.get(sessionId)?.pending ?? null;
}

export function getSessionRuntimeControlSnapshot(sessionId: string): SessionRuntimeControlSnapshot {
  const state = states.get(sessionId);
  if (!state) {
    return {
      generation: 0,
      effectiveOverride: null,
      pending: null,
      fallbackHop: 0,
      visitedRoutes: [],
    };
  }
  return {
    generation: state.generation,
    effectiveOverride: state.effectiveOverride,
    pending: state.pending,
    fallbackHop: state.fallbackHop,
    visitedRoutes: [...state.visitedRoutes],
  };
}

export function clearSessionRuntimeControlState(sessionId: string): void {
  states.delete(sessionId);
}

export function clearAllSessionRuntimeControlStates(): void {
  ownerEpoch += 1;
  states.clear();
}

export function captureSessionRuntimeControlOwnerEpoch(): string {
  return String(ownerEpoch);
}

export function sessionRuntimeControlOwnerEpochMatches(expected: string): boolean {
  return captureSessionRuntimeControlOwnerEpoch() === expected;
}

const EFFORT_ORDER: readonly Effort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function resolveCompatibleSessionRuntimeEffort(
  model: CatalogModel,
  requested: Effort | null,
): Effort | null {
  if (model.efforts.length === 0) return null;
  if (requested && model.efforts.includes(requested)) return requested;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort))
    return model.defaultEffort;
  if (!requested) return model.efforts[0] ?? null;
  const requestedRank = EFFORT_ORDER.indexOf(requested);
  return (
    [...model.efforts].sort(
      (a, b) =>
        Math.abs(EFFORT_ORDER.indexOf(a) - requestedRank) -
        Math.abs(EFFORT_ORDER.indexOf(b) - requestedRank),
    )[0] ?? null
  );
}

export function resolveSessionRuntimeAxes(params: {
  model: CatalogModel;
  effort: Effort | null;
  fastMode: boolean;
  effortExplicit: boolean;
  fastExplicit: boolean;
  allowFixedEffortPlaceholder?: boolean;
}):
  | { ok: true; effort: Effort | null; fastMode: boolean }
  | { ok: false; reason: 'effort-unavailable' | 'fast-unavailable' } {
  if (
    params.effortExplicit &&
    params.effort !== null &&
    !params.model.efforts.includes(params.effort) &&
    !(
      params.allowFixedEffortPlaceholder === true &&
      params.model.efforts.length === 0
    )
  ) {
    return { ok: false, reason: 'effort-unavailable' };
  }
  if (params.fastExplicit && params.fastMode && params.model.supportsFastMode !== true) {
    return { ok: false, reason: 'fast-unavailable' };
  }
  return {
    ok: true,
    effort: resolveCompatibleSessionRuntimeEffort(params.model, params.effort),
    fastMode: params.fastMode && params.model.supportsFastMode === true,
  };
}

export function pickSessionRuntimeFallback(params: {
  providers: readonly ProviderView[];
  current: SessionRuntimeProfile;
  visitedRoutes: readonly string[];
  maxHops: number;
  currentHop: number;
}): SessionRuntimeProfile | null {
  if (params.currentHop >= params.maxHops) return null;
  const visited = new Set(params.visitedRoutes);
  visited.add(routeKey(params.current));
  const rail = connectedProvidersForAgent([...params.providers], params.current.agentKind);
  const candidates: Array<{ providerId: string; model: CatalogModel }> = [];

  for (const provider of rail) {
    for (const model of provider.models[params.current.agentKind] ?? []) {
      if (
        !isModelSelectableForNewRoute(model, {
          userProvider: provider.source === 'user',
        })
      ) {
        continue;
      }
      if (model.id === params.current.model && provider.id !== params.current.providerId) {
        candidates.push({ providerId: provider.id, model });
      }
    }
  }
  for (const provider of rail) {
    for (const model of provider.models[params.current.agentKind] ?? []) {
      if (
        !isModelSelectableForNewRoute(model, {
          userProvider: provider.source === 'user',
        })
      ) {
        continue;
      }
      if (!model.newSessionDefault?.includes(params.current.agentKind)) continue;
      candidates.push({ providerId: provider.id, model });
    }
  }

  for (const candidate of candidates) {
    const key = routeKey({ providerId: candidate.providerId, model: candidate.model.id });
    if (visited.has(key)) continue;
    const axes = resolveSessionRuntimeAxes({
      model: candidate.model,
      effort: params.current.effort,
      fastMode: params.current.fastMode,
      effortExplicit: false,
      fastExplicit: false,
    });
    if (!axes.ok) continue;
    return {
      agentKind: params.current.agentKind,
      model: candidate.model.id,
      providerId: candidate.providerId,
      effort: axes.effort,
      fastMode: axes.fastMode,
    };
  }
  return null;
}
