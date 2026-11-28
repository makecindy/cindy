import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { onAuxiliaryModelSettingsRead } from './auxiliary-model-settings-store.js';
import { getEffectiveAuxiliaryModelChain } from './resolveAuxiliaryModelChain.js';
import { trustedHttpError } from './auxiliaryUpstreamError.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import type { UtilityTextAttempt, UtilityTextResult } from '../../shared/utilityTextResult.js';
import {
  auxiliaryFailureReason,
  type AuxiliaryNoticeOperation,
  type AuxiliaryModelHealthEvent,
  type AuxiliaryModelHealthSnapshot,
} from '../../shared/auxiliaryModelHealth.js';

const RETRY_AFTER_MS = 60_000;
const NOTICE_COOLDOWN_MS = 30 * 60_000;
type Route = {
  outcomes: boolean[];
  latest?: AuxiliaryModelHealthSnapshot;
  message?: string;
  messageSession?: string;
  stillCurrent?: () => boolean;
  retryAt: number;
  lastNoticeAt: number;
};
const routes = new Map<string, Route>();
// Per-session views represent the completed chain. Route health also includes
// automatic calls and failed candidates from requests that ultimately succeeded.
const conversations = new Map<string, { rows: AuxiliaryModelHealthSnapshot[] }>();
// Details are capped at 32 chats. Keep only the IDs of chats explicitly muted
// during this saved chain's current outage, independent of detail-cache evictions.
const dismissedSessions = new Set<string>();
let nextNoticeId = 0;
let scope: string;
let errorRevision = 0;
let conversationGeneration = 0;
let effectiveChainKey: string | undefined;
let requestSequence = 0;
const lastCompletedRequest = new Map<string, number>();
let broadcast: ((channel: string, event: AuxiliaryModelHealthEvent) => void) | undefined;

export function setAuxiliaryModelHealthBroadcaster(sender: typeof broadcast): void {
  broadcast = sender;
}

function scopedRoutes() {
  const current = activeOwnerScopeKey();
  if (current !== scope) {
    routes.clear();
    conversations.clear();
    dismissedSessions.clear();
    lastCompletedRequest.clear();
    effectiveChainKey = undefined;
    scope = current;
  }
  return routes;
}

function key(providerId: string, model: string, ref?: string) {
  return ref ?? JSON.stringify([providerId, model]);
}

function currentRoute(id: string) {
  const state = scopedRoutes();
  const route = state.get(id);
  if (route?.stillCurrent && !route.stillCurrent()) {
    state.delete(id);
    if (dismissedSessions.size && getEffectiveAuxiliaryModelChain().refs.includes(id)) dismissedSessions.clear();
    for (const [sessionId, { rows }] of conversations) {
      if (rows.some(row => row.auxiliaryRef === id)) clearConversation(sessionId);
    }
    if (route.latest) broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, { ...route.latest, removed: true });
    return undefined;
  }
  return route;
}

/** Only a real request can claim the next retry, including when no backup exists. */
export function isAuxiliaryModelTemporarilyUnavailable(providerId: string, model: string, ref?: string, onClaim?: (release: () => void) => void): boolean {
  const route = currentRoute(key(providerId, model, ref));
  if (route?.latest?.status !== 'isolated') return false;
  if (Date.now() < route.retryAt) return true;
  const claimed = route.latest;
  const retryAt = Date.now() + RETRY_AFTER_MS;
  route.retryAt = retryAt;
  onClaim?.(() => {
    if (route.latest === claimed && route.retryAt === retryAt) route.retryAt = 0;
  });
  return false;
}

function observe(providerId: string, model: string, failure: UtilityTextAttempt | undefined, switchedToBackup: boolean, sessionId?: string, auxiliaryRef?: string, stillCurrent?: () => boolean) {
  if (!providerId || !model) return;
  const id = key(providerId, model, auxiliaryRef);
  const state = scopedRoutes();
  const existing = currentRoute(id);
  if (stillCurrent && !stillCurrent()) return;
  const route: Route = existing ?? { outcomes: [], retryAt: 0, lastNoticeAt: -Infinity };
  if (stillCurrent) route.stillCurrent = stillCurrent;
  state.set(id, route);
  if (failure?.status !== 'skipped' || transientPreparationFailure(failure)) {
    route.outcomes.push(!failure);
    if (route.outcomes.length > 10) route.outcomes.shift();
  }
  const previous = route.latest;
  if (!failure && !previous) return;
  const reason = failure ? auxiliaryFailureReason(failure) : previous!.reason;
  const failures = route.outcomes.filter(ok => !ok).length;
  const deterministic = ['quota', 'permission_denied', 'not_authenticated', 'api_key_missing', 'endpoint_missing', 'model_unavailable', 'unsupported_transport'].includes(reason);
  const now = Date.now();
  let status: AuxiliaryModelHealthSnapshot['status'] = 'monitoring';
  if (failure) {
    if (deterministic || failures >= 5 || previous?.status === 'isolated') {
      status = 'isolated';
      route.retryAt = now + RETRY_AFTER_MS;
    } else if (failures >= 3) status = 'warning';
  } else if (previous?.status === 'warning' && failures >= 3) {
    status = 'warning';
  } else if (previous?.status === 'isolated' || previous?.status === 'warning') {
    status = 'recovered';
  }
  const snapshot: AuxiliaryModelHealthSnapshot = {
    ownerStamp: getActiveDataOwnerPushStamp(), providerId, model, auxiliaryRef,
    errorRevision: failure ? ++errorRevision : previous?.errorRevision,
    reason, status, lastErrorAt: failure ? now : previous!.lastErrorAt,
    attemptCount: route.outcomes.length, failureCount: failures,
    failureRate: failures / Math.max(1, route.outcomes.length), switchedToBackup,
  };
  if (failure) {
    const detail = trustedHttpError(failure);
    route.message = detail.upstreamMessage;
    route.messageSession = sessionId;
    if (detail.httpStatus) snapshot.httpStatus = detail.httpStatus;
  } else if (previous?.httpStatus !== undefined) snapshot.httpStatus = previous.httpStatus;
  route.latest = snapshot;
  broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, snapshot);
}

function clearConversation(sessionId: string) {
  const view = conversations.get(sessionId);
  if (!view) return;
  conversations.delete(sessionId);
  for (const row of view.rows) {
    broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, {
      ...row, upstreamMessage: undefined, removed: true, conversationOnly: true,
    });
  }
}

/** A delayed click must not close a later incident, even for the same owner and session. */
export function dismissAuxiliaryModelNotice(sessionId: string, noticeId: number): void {
  const visible = getAuxiliaryModelHealthSnapshot(sessionId)[0];
  if (visible && visible.noticeId === noticeId) {
    if (visible.status !== 'recovered') dismissedSessions.add(sessionId);
    clearConversation(sessionId);
  }
}

function updateConversation(sessionId: string | undefined, result: UtilityTextResult, operation?: AuxiliaryNoticeOperation) {
  const chain = getEffectiveAuxiliaryModelChain();
  if (chain.source !== 'custom' || !chain.refs.length) return;
  if (result.ok && result.auxiliaryRef && chain.refs.includes(result.auxiliaryRef)) {
    // A usable result ends the whole-chain outage, even if the route's rolling
    // failure rate is still high. Only the completing chat may announce recovery.
    dismissedSessions.clear();
    for (const [otherId, { rows }] of conversations) {
      if (otherId !== sessionId && rows.some(row => row.auxiliaryRef === result.auxiliaryRef && row.status !== 'recovered')) {
        clearConversation(otherId);
      }
    }
  }
  if (!sessionId || dismissedSessions.has(sessionId)) return;
  const previous = conversations.get(sessionId);
  const hadOutage = previous?.rows.some(row => row.status === 'warning' || row.status === 'isolated');
  let views: AuxiliaryModelHealthSnapshot[] = [];
  if (result.ok) {
    if (!previous) return;
    clearConversation(sessionId);
    // A successful backup should never interrupt the conversation, even when
    // it clears an earlier outage. Announce recovery only on the preferred route.
    if (!hadOutage || result.auxiliaryRef !== chain.refs[0]) return;
    const primary = currentRoute(chain.refs[0])?.latest;
    if (primary) views = [{ ...primary, status: 'recovered', sessionId, switchedToBackup: false }];
  } else {
    for (const ref of chain.refs) {
      const route = currentRoute(ref);
      const latest = route?.latest;
      const matched = result.attempts.some(attempt => attempt.auxiliaryRef === ref &&
        !attempt.outputRejected && (attempt.paused || attempt.status === 'failed' || preflightFailure(attempt)));
      if (!matched || !latest || (latest.status !== 'warning' && latest.status !== 'isolated')) return;
      views.push({ ...latest, sessionId, operation, switchedToBackup: false,
        upstreamMessage: route.messageSession === sessionId ? route.message : undefined });
    }
  }
  if (!views.length) return;
  conversations.delete(sessionId);
  const noticeId = hadOutage && !result.ok ? previous!.rows[0].noticeId : ++nextNoticeId;
  for (const view of views) view.noticeId = noticeId;
  conversations.set(sessionId, { rows: views });
  const oldest = conversations.keys().next().value;
  if (conversations.size > 32 && oldest) clearConversation(oldest);
  const first = views[0];
  const route = currentRoute(chain.refs[0]);
  if (!route) return;
  const notify = result.ok || (!hadOutage && Date.now() - route.lastNoticeAt >= NOTICE_COOLDOWN_MS);
  if (notify && !result.ok) route.lastNoticeAt = Date.now();
  broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, {
    ...first, upstreamMessage: undefined, conversationOnly: true, notify,
  });
}

function transientPreparationFailure(attempt: UtilityTextAttempt) {
  return attempt.reason === 'auth_probe_failed' || attempt.reason === 'agent_unavailable';
}

function preflightFailure(attempt: UtilityTextAttempt) {
  return attempt.status === 'skipped' && !attempt.paused &&
    (transientPreparationFailure(attempt) || ['not_authenticated', 'api_key_missing', 'endpoint_missing', 'model_unavailable', 'unsupported_transport'].includes(attempt.reason));
}

/** Ignore a previous custom chain's conversation attribution even if the same pins are saved again. */
export function captureAuxiliaryHealthObserver(chain = getEffectiveAuxiliaryModelChain()): typeof recordAuxiliaryModelResult {
  retainAuxiliaryModelRoutes(chain);
  const generation = conversationGeneration;
  const sequence = ++requestSequence;
  return (result, options) => {
    if (isAppSessionBoundaryPending() || options?.bypassHealth) return;
    if (generation !== conversationGeneration) return;
    const sessionId = options?.sessionId;
    if (sessionId) {
      scopedRoutes();
      if (sequence < (lastCompletedRequest.get(sessionId) ?? 0)) {
        recordRouteResult(result, { ...options, sessionId: undefined });
        return;
      }
      lastCompletedRequest.delete(sessionId);
      lastCompletedRequest.set(sessionId, sequence);
      const oldest = lastCompletedRequest.keys().next().value;
      if (lastCompletedRequest.size > 64 && oldest) lastCompletedRequest.delete(oldest);
    }
    recordAuxiliaryModelResult(result, options);
  };
}

type HealthOptions = { bypassHealth?: boolean; sessionId?: string; operation?: AuxiliaryNoticeOperation; routeGuards?: ReadonlyMap<string, () => boolean> };

function recordRouteResult(result: UtilityTextResult, options?: HealthOptions): void {
  for (const attempt of result.attempts ?? []) {
    const switched = result.ok && key(attempt.providerId, attempt.model, attempt.auxiliaryRef) !== key(result.providerId, result.model, result.auxiliaryRef);
    if ((attempt.status === 'failed' && !attempt.outputRejected) || preflightFailure(attempt)) {
      observe(attempt.providerId, attempt.model, attempt, switched, options?.sessionId, attempt.auxiliaryRef, options?.routeGuards?.get(attempt.auxiliaryRef ?? ''));
    }
  }
  if (result.ok) observe(result.providerId, result.model, undefined, false, options?.sessionId, result.auxiliaryRef, options?.routeGuards?.get(result.auxiliaryRef ?? ''));
}

export function recordAuxiliaryModelResult(result: UtilityTextResult, options?: HealthOptions): void {
  if (isAppSessionBoundaryPending() || options?.bypassHealth) return;
  recordRouteResult(result, options);
  if ((options?.sessionId || result.ok && result.auxiliaryRef) && ![...(options?.routeGuards?.values() ?? [])].some(guard => !guard())) {
    updateConversation(options?.sessionId, result, options?.operation);
  }
}

/** Commit the successful probes only after the entire draft is effective. */
export function recoverTestedAuxiliaryRoutes(refs: readonly string[]): void {
  for (const ref of refs) {
    const latest = currentRoute(ref)?.latest;
    if (latest && (latest.status === 'isolated' || latest.status === 'warning')) {
      observe(latest.providerId, latest.model, undefined, false, latest.sessionId, ref);
    }
  }
}

/** Connect all Desktop reads (including settings opened without a dispatch) to the same lifecycle. */
export function observeAuxiliarySettingsReads(): void {
  onAuxiliaryModelSettingsRead(models => retainAuxiliaryModelRoutes(getEffectiveAuxiliaryModelChain(models)));
}

/** Remove obsolete alerts as soon as the replacement chain becomes effective. */
export function retainAuxiliaryModelRoutes(chain: ReturnType<typeof getEffectiveAuxiliaryModelChain>, saved = false): void {
  const state = scopedRoutes();
  const identity = JSON.stringify([chain.source, chain.refs]);
  const previous = effectiveChainKey;
  effectiveChainKey = identity;
  if (!saved && (previous === undefined || previous === identity)) return;
  // Even A → B → A may finish while an old dispatch is still in flight.
  conversationGeneration++;
  dismissedSessions.clear();
  lastCompletedRequest.clear();
  for (const sessionId of conversations.keys()) clearConversation(sessionId);
  for (const [id, route] of state) {
    if (chain.refs.includes(id)) {
      if (chain.source !== 'custom' && route.latest) {
        route.lastNoticeAt = -Infinity;
        route.latest = { ...route.latest, sessionId: undefined };
        broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, { ...route.latest, conversationOnly: true, removed: true });
      }
      continue;
    }
    state.delete(id);
    if (route.latest) broadcast?.(MAKER_PUSH.AUXILIARY_MODEL_HEALTH_CHANGED, { ...route.latest, removed: true });
  }
}

export function getAuxiliaryModelHealthSnapshot(sessionId?: string): AuxiliaryModelHealthSnapshot[] {
  if (isAppSessionBoundaryPending()) return [];
  const chain = getEffectiveAuxiliaryModelChain();
  retainAuxiliaryModelRoutes(chain);
  const state = scopedRoutes();
  if (sessionId !== undefined) {
    if (chain.source !== 'custom') return [];
    const conversation = conversations.get(sessionId);
    if (!conversation) return [];
    const view = conversation.rows;
    if (view.some(row => !row.auxiliaryRef || !chain.refs.includes(row.auxiliaryRef) || !currentRoute(row.auxiliaryRef))) {
      clearConversation(sessionId);
      return [];
    }
    return view;
  }
  return [...state.keys()].flatMap(id => {
    const route = currentRoute(id);
    if (!route?.latest) return [];
    const message = route.message;
    return [message ? { ...route.latest, upstreamMessage: message } : route.latest];
  })
    .sort((a, b) => b.lastErrorAt - a.lastErrorAt);
}

export const __testing = { reset: () => { routes.clear(); conversations.clear(); dismissedSessions.clear(); effectiveChainKey = undefined; } };
