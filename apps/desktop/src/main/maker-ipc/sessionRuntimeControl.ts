import type { AgentKind, Effort, EngineKind } from '@cindy/maker-core';
import type { Session as RendererSession } from '../../renderer/lib/ccAgent.types';
import { makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { modelGroupCandidateKey } from '../../shared/modelGroups.js';
import { clearAllSessionProviders } from '../maker-host/session-provider-store.js';
import { clearAllSessionRuntimeAxes } from '../maker-host/session-effort-store.js';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  resolveCodexCompatibilityWireProtocol,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

export type SessionRuntimeMutationSource = 'agent' | 'fallback';

export type SessionRuntimeRouteChangeActor =
  | 'user'
  | 'agent'
  | 'fallback'
  | 'model-group'
  | 'provider-group'
  | 'config-sync'
  | 'scheduler'
  | 'unknown';

export interface SessionRuntimeRouteEndpoint {
  agentKind: EngineKind;
  model: string | null;
  providerId: string | null;
  agentDeviceId: string | null;
}

export interface SessionRuntimeRouteChange {
  /** ISO-8601 UTC timestamp when the route change committed. */
  at: string;
  by: SessionRuntimeRouteChangeActor;
  /** Bounded machine-readable reason code (never raw prompt, error text, or credentials). */
  reason: string | null;
  from: SessionRuntimeRouteEndpoint;
  to: SessionRuntimeRouteEndpoint;
}

export interface SessionRuntimeRouteChangeAttribution {
  by?: SessionRuntimeRouteChangeActor;
  reason?: string | null;
}

const SAFE_ROUTE_CHANGE_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Only allow bounded machine-readable reason tokens; never leak raw error text, paths, or credentials. */
export function sanitizeRouteChangeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return SAFE_ROUTE_CHANGE_REASON.test(trimmed) ? trimmed : null;
}

export function runtimeRouteEndpointsEqual(
  a: SessionRuntimeRouteEndpoint,
  b: SessionRuntimeRouteEndpoint,
): boolean {
  return (
    a.agentKind === b.agentKind &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.providerId ?? null) === (b.providerId ?? null) &&
    (a.agentDeviceId ?? null) === (b.agentDeviceId ?? null)
  );
}

export interface SessionRuntimeProfile {
  agentDeviceId?: string | null;
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: Effort | null;
  fastMode: boolean | 'ultrafast';
}

/** Plugin routes persist on the session row; only built-in engines use a temporary runtime override. */
export type FallbackRouteProfile = (SessionRuntimeProfile | (Omit<SessionRuntimeProfile, 'agentKind'> & { agentKind: 'acp' })) & {
  /** Internal recovery-source identity, not part of the projected runtime profile. */
  accountId?: string;
};
type FallbackRouteIdentity = Pick<FallbackRouteProfile, 'agentKind' | 'providerId' | 'model' | 'agentDeviceId' | 'accountId'>;

export interface PendingSessionRuntimeMutation {
  generation: number;
  source: SessionRuntimeMutationSource;
  profile: SessionRuntimeProfile;
  /**
   * Pi-only：该选择的思考开关意图（renderer 记忆，缺省开）。settle 重放时随
   * selection 一并应用；不落 DB（会随 runtimePending 投影带出，renderer 不消费）。
   */
  thinking?: boolean;
  /** Preserved through turn-end deferral so settlement records accurate route attribution. */
  routeChangeAttribution?: SessionRuntimeRouteChangeAttribution;
}

export interface SessionRuntimeControlSnapshot {
  generation: number;
  effectiveOverride: SessionRuntimeProfile | null;
  pending: PendingSessionRuntimeMutation | null;
  fallbackHop: number;
  visitedRoutes: string[];
  lastRouteChange: SessionRuntimeRouteChange | null;
}

function runtimeOverrideForDevice(profile: SessionRuntimeProfile | null, agentDeviceId?: string | null) {
  return profile && (profile.agentDeviceId ?? null) === (agentDeviceId ?? null) ? profile : null;
}

function runtimeOverrideForStart(sessionId: string, agentKind: EngineKind, agentDeviceId?: string | null) {
  const profile = runtimeOverrideForDevice(getSessionRuntimeControlSnapshot(sessionId).effectiveOverride, agentDeviceId);
  return profile?.agentKind === agentKind ? profile : null;
}

/** Startup-only projection; persisted preferences and native-history identity stay on the row. */
export function getSessionRuntimeStartOverride(sessionId: string, agentKind: EngineKind, agentDeviceId?: string | null) {
  const profile = runtimeOverrideForStart(sessionId, agentKind, agentDeviceId);
  if (!profile) return {};
  return { model: profile.model, providerId: profile.providerId,
    effort: profile.effort ?? undefined, fastMode: profile.fastMode };
}

/** Shared by full session reads and route-change pushes; all axes come from one profile. */
export function projectSessionRuntimeControl(
  sessionId: string,
  baseline: SessionRuntimeProfile,
  agentDeviceId = baseline.agentDeviceId,
): Partial<RendererSession> {
  const control = getSessionRuntimeControlSnapshot(sessionId);
  // A route-change push can run while an override from the previous computer still exists.
  const effective = runtimeOverrideForDevice(control.effectiveOverride, agentDeviceId) ?? baseline;
  return {
    agentKind: makerToDbAgentKind(effective.agentKind),
    model: effective.model,
    providerId: effective.providerId,
    // The legacy wire axis is string-compatible; the profile preserves null.
    effort: effective.effort ?? '',
    fastMode: effective.fastMode,
    runtimeGeneration: control.generation,
    runtimeBaseline: baseline,
    runtimeEffective: effective,
    runtimePending: control.pending,
    runtimeBaselineRecoveryPending: false,
    ...(control.lastRouteChange ? { runtimeLastRouteChange: control.lastRouteChange } : {}),
  };
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
  lastRouteChange: SessionRuntimeRouteChange | null;
}

const states = new Map<string, SessionRuntimeControlState>();
let ownerEpoch = 0;

function routeKey(profile: FallbackRouteIdentity): string {
  return modelGroupCandidateKey({ ...profile, providerId: profile.providerId ?? '' });
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
      lastRouteChange: null,
    };
    states.set(sessionId, state);
  }
  return state;
}

/**
 * Record the latest committed route change for observability (`get_session_runtime`,
 * `get_task_digest`, and remote `local-db:sessions:get` projection). Axis-only or
 * no-op updates leave the previous route-change attribution intact unless `force` is set
 * (e.g., forced relocation behind a shared logical provider ID).
 */
export function recordSessionRuntimeRouteChange(
  sessionId: string,
  change: {
    at?: string;
    by: SessionRuntimeRouteChangeActor;
    reason?: string | null;
    from: SessionRuntimeRouteEndpoint;
    to: SessionRuntimeRouteEndpoint;
  },
  options?: { force?: boolean },
): SessionRuntimeRouteChange | null {
  const from: SessionRuntimeRouteEndpoint = {
    agentKind: change.from.agentKind,
    model: change.from.model ?? null,
    providerId: change.from.providerId ?? null,
    agentDeviceId: change.from.agentDeviceId ?? null,
  };
  const to: SessionRuntimeRouteEndpoint = {
    agentKind: change.to.agentKind,
    model: change.to.model ?? null,
    providerId: change.to.providerId ?? null,
    agentDeviceId: change.to.agentDeviceId ?? null,
  };
  if (!options?.force && runtimeRouteEndpointsEqual(from, to)) return null;
  const recorded: SessionRuntimeRouteChange = {
    at: change.at ?? new Date().toISOString(),
    by: change.by,
    reason: sanitizeRouteChangeReason(change.reason),
    from,
    to,
  };
  stateFor(sessionId).lastRouteChange = recorded;
  return recorded;
}

export function sessionRuntimeGenerationMatches(
  sessionId: string,
  expectedGeneration: number | undefined,
): boolean {
  return expectedGeneration === undefined || (states.get(sessionId)?.generation ?? 0) === expectedGeneration;
}

export function recordUserSessionRuntimeMutation(
  sessionId: string,
  options?: { preserveEffective?: boolean },
): number {
  const state = stateFor(sessionId);
  state.generation += 1;
  if (!options?.preserveEffective) state.effectiveOverride = null;
  state.pending = null;
  state.pendingRouteExplicit = true;
  state.fallbackHop = 0;
  state.visitedRoutes.clear();
  return state.generation;
}

/** Account handoff changes only the admitted source, preserving temporary model/axis intent. */
export function remapSessionRuntimeProvider(params: {
  sessionId: string;
  fromProviderId: string;
  toProviderId: string;
  expectedOwnerEpoch: string;
  expectedGeneration: number;
  recordRouteChange?: {
    agentKind: EngineKind;
    model: string | null;
    agentDeviceId: string | null;
  };
}): number | null {
  if (!sessionRuntimeControlOwnerEpochMatches(params.expectedOwnerEpoch)) return null;
  const existing = states.get(params.sessionId);
  const generation = existing?.generation ?? 0;
  if (generation !== params.expectedGeneration) return null;
  const state = existing ?? stateFor(params.sessionId);
  const effective = state.effectiveOverride;
  // The admitted route changed even without an override; fence every old Agent snapshot.
  state.generation += 1;
  if (effective?.providerId === params.fromProviderId)
    state.effectiveOverride = { ...effective, providerId: params.toProviderId };
  if (state.pending) {
    state.pending = { ...state.pending, generation: state.generation,
      profile: effective?.providerId === params.fromProviderId && routeKey(state.pending.profile) === routeKey(effective)
        ? { ...state.pending.profile, providerId: params.toProviderId } : state.pending.profile };
  }
  if (params.recordRouteChange && params.fromProviderId !== params.toProviderId) {
    recordSessionRuntimeRouteChange(params.sessionId, {
      by: 'provider-group',
      reason: 'provider-remap',
      from: {
        agentKind: params.recordRouteChange.agentKind,
        model: params.recordRouteChange.model,
        providerId: params.fromProviderId,
        agentDeviceId: params.recordRouteChange.agentDeviceId,
      },
      to: {
        agentKind: params.recordRouteChange.agentKind,
        model: params.recordRouteChange.model,
        providerId: params.toProviderId,
        agentDeviceId: params.recordRouteChange.agentDeviceId,
      },
    });
  }
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
  /** Pi-only：延期期间也要记住目标模型的思考开关意图（结算重放时用）。 */
  thinking?: boolean;
}): number {
  const state = stateFor(params.sessionId);
  const hadPendingMutation = state.pending !== null;
  state.generation += 1;
  state.pending = state.pending
    ? {
        ...state.pending,
        generation: state.generation,
        profile: { ...state.pending.profile, ...params.pendingPatch },
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
      }
    : {
        generation: state.generation,
        source: params.source,
        profile: { ...params.effectiveProfile, ...params.pendingPatch },
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
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
  previousProfile?: FallbackRouteProfile;
  thinking?: boolean;
  routeChangeAttribution?: SessionRuntimeRouteChangeAttribution;
} & (
  | { source: SessionRuntimeMutationSource; profile: SessionRuntimeProfile; deferred: boolean }
  | { source: 'fallback'; profile: FallbackRouteProfile; deferred: false }
)): number {
  const state = stateFor(params.sessionId);
  const previousPending = state.pending;
  state.generation += 1;
  // 延期替换时若本次没算出意图（undefined），且仍指向**同一个目标**（model 与
  // provider 都相同），继承上一份 pending：一次「无法判定」的点击不该把用户刚
  // 表达过的思考开关悄悄清掉。换到别的模型时不继承——旧模型的开关不适用，
  // 否则 A 的 off 会串给 B；false / true 是明确意图，永远以本次为准。
  const samePendingTarget =
    previousPending != null &&
    previousPending.profile.model === params.profile.model &&
    (previousPending.profile.providerId ?? null) === (params.profile.providerId ?? null);
  const acceptedThinking =
    params.thinking ??
    (params.deferred && samePendingTarget ? previousPending?.thinking : undefined);
  let accepted: PendingSessionRuntimeMutation | null = null;
  const candidate: FallbackRouteProfile = params.profile;
  if (candidate.agentKind !== 'acp') {
    const { accountId: _accountId, ...profile } = candidate;
    accepted = {
      generation: state.generation,
      source: params.source,
      profile,
      ...(acceptedThinking !== undefined ? { thinking: acceptedThinking } : {}),
      ...(params.deferred && params.routeChangeAttribution
        ? { routeChangeAttribution: params.routeChangeAttribution }
        : {}),
    };
  }
  state.pending = params.deferred ? accepted : null;
  state.pendingRouteExplicit = true;
  if (!params.deferred) state.effectiveOverride = accepted?.profile ?? null;
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

/**
 * 一条新消息(用户发的，或自动化、目标、协同发来的；自动续跑那一条不算)开始了新的一轮：「这一轮已经试过失败的」
 * 清空，之前失败过、现在可能已恢复的来源(例如额度已重置)重新可以接替。不清跳数：它还决定任务是否在接替来源上。
 * 原来只在用户换模型时清空，跑得久的任务每个来源都失败过一次以后就再也不会自动换(2026-11-26 排查)。
 */
export function startSessionRuntimeFallbackTurn(sessionId: string): void {
  states.get(sessionId)?.visitedRoutes.clear();
}

export function recordFailedSessionRuntimeFallbackCandidate(
  sessionId: string,
  expectedGeneration: number,
  profile: FallbackRouteIdentity,
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

/**
 * A task runtime starts on its accepted, not deferred runtime mutation (an automatic route fallback,
 * a change applied to a live runtime) rather than the stored route; the provider stays the caller's
 * when a provider group decides the source. Called before the start admission (the desktop's
 * bootstrapSession; the Node Host's runtime starts, which pass false: it refuses provider-group tasks).
 * Returns the task's accepted built-in route override, which the start then reads again: a
 * started runtime keeps the saved provider baseline and takes its effort and Fast axes from it.
 */
export function applySessionRuntimeOverrideForStart(
  o: { id?: string; agentKind: EngineKind; agentDeviceId?: string | null; model?: string; providerId?: string | null; effort?: Effort; fastMode?: boolean | 'ultrafast' },
  groupDecidesSource: boolean,
): SessionRuntimeProfile | null {
  const runtimeOverride =
    typeof o.id === 'string' ? runtimeOverrideForStart(o.id, o.agentKind, o.agentDeviceId) : null;
  if (runtimeOverride) {
    o.model = runtimeOverride.model;
    if (!groupDecidesSource) o.providerId = runtimeOverride.providerId;
    o.effort = runtimeOverride.effort ?? undefined;
    o.fastMode = runtimeOverride.fastMode;
  }
  return runtimeOverride;
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
      lastRouteChange: null,
    };
  }
  return {
    generation: state.generation,
    effectiveOverride: state.effectiveOverride,
    pending: state.pending,
    fallbackHop: state.fallbackHop,
    visitedRoutes: [...state.visitedRoutes],
    lastRouteChange: state.lastRouteChange,
  };
}

export function clearSessionRuntimeControlState(sessionId: string): void {
  states.delete(sessionId);
}

/** /clear hides prior history but preserves the selected runtime and pending route. */
export function clearSessionRuntimeRouteChange(sessionId: string): void {
  const state = states.get(sessionId);
  if (state) state.lastRouteChange = null;
}

export function clearAllSessionRuntimeControlStates(): void {
  ownerEpoch += 1;
  states.clear();
}

/**
 * The owner-scoped runtime selection a committed account change drops (the app session commit
 * boundary): every task's provider, its runtime axes, and the runtime control states (which also
 * advance the owner epoch). The desktop's boundary hook and the Node Host's both call it.
 */
export function clearOwnerScopedSessionRuntimeSelection(): void {
  clearAllSessionProviders();
  clearAllSessionRuntimeAxes();
  clearAllSessionRuntimeControlStates();
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

/** A cleared fixed-effort axis must not revive the NOT NULL row's historical rank. */
export function resolveSessionRuntimeRefreshEffort(params: {
  model: CatalogModel | null;
  storedEffort: Effort | null;
  persistedEffort: Effort | null;
}): Effort | null {
  return params.storedEffort ?? (params.model
    ? resolveCompatibleSessionRuntimeEffort(params.model, params.persistedEffort)
    : params.persistedEffort);
}

export function resolveSessionRuntimeAxes(params: {
  model: CatalogModel;
  effort: Effort | null;
  fastMode: boolean | 'ultrafast';
  effortExplicit: boolean;
  fastExplicit: boolean;
  allowFixedEffortPlaceholder?: boolean;
}):
  | { ok: true; effort: Effort | null; fastMode: boolean | 'ultrafast' }
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
  if (params.fastExplicit && params.fastMode && (params.model.supportsFastMode !== true || (params.fastMode === 'ultrafast' && params.model.supportsUltrafastMode !== true))) {
    return { ok: false, reason: 'fast-unavailable' };
  }
  return {
    ok: true,
    effort: resolveCompatibleSessionRuntimeEffort(params.model, params.effort),
    fastMode: params.model.supportsFastMode === true && (params.fastMode !== 'ultrafast' || params.model.supportsUltrafastMode === true) ? params.fastMode : false,
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
  const currentProvider = params.providers.find((provider) => provider.id === params.current.providerId);
  const currentModel = currentProvider?.models[params.current.agentKind]?.find(
    (model) => model.id === params.current.model,
  );
  // Model names do not establish wire compatibility. In particular, a completed
  // web_search_call may be serializable by a bridge while the next native search
  // remains unsupported. Generic fallback has no task/request capability proof,
  // so keep Codex on its current transport instead of silently introducing a bridge.
  // Explicit model routes override provider defaults in the actual Codex route.
  const effectiveWireProtocol = (provider: ProviderView, model: CatalogModel): string =>
    model.route?.wireProtocol ??
    resolveCodexCompatibilityWireProtocol(provider, params.current.agentKind, model) ??
    provider.routing.codex?.wireProtocol ?? 'openai-responses';
  const currentCompatibility = currentProvider && currentModel
    ? effectiveWireProtocol(currentProvider, currentModel)
    : null;
  const compatibleProvider = (provider: ProviderView, model: CatalogModel): boolean =>
    params.current.agentKind !== 'codex' || (
      currentProvider !== undefined && currentModel !== undefined &&
      effectiveWireProtocol(provider, model) === currentCompatibility
    );

  for (const provider of rail) {
    for (const model of provider.models[params.current.agentKind] ?? []) {
      if (
        !isModelSelectableForNewRoute(model, {
          userProvider: provider.source === 'user',
        })
      ) {
        continue;
      }
      if (compatibleProvider(provider, model) && model.id === params.current.model && provider.id !== params.current.providerId) {
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
      if (!compatibleProvider(provider, model) || !model.newSessionDefault?.includes(params.current.agentKind)) continue;
      candidates.push({ providerId: provider.id, model });
    }
  }

  for (const candidate of candidates) {
    const key = routeKey({
      agentKind: params.current.agentKind,
      providerId: candidate.providerId,
      model: candidate.model.id,
    });
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
