import {
  REMOTE_UTILITY_TEXT_MAX_TIMEOUT_MS,
  parseRemoteUtilityRequest,
  parseRemoteUtilityResponse,
  type RemoteUtilityError,
  type RemoteUtilityResponse,
  type RemoteUtilityRoute,
} from '@cindy/device-link';
import type { UtilityTextRequestOptions } from '../oneShotCandidatesCore.js';
import { requestUtilityTextWithinTimeout } from '../utilityTextTimeout.js';
import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';

export type RemoteUtilityScope = { owner: string; hostEpoch: string };
export type RemoteUtilitySnapshot = RemoteUtilityScope & { authorizationEpoch: string };
export interface RemoteUtilityHostDeps {
  current(caller: string, route?: RemoteUtilityRoute): RemoteUtilitySnapshot | null;
  allowedRoutes(caller: string): Promise<readonly RemoteUtilityRoute[]>;
  execute(prompt: string, options: UtilityTextRequestOptions & {
    providerId: string;
    agentKind: RemoteUtilityRoute['agentKind'];
    model: string;
    signal: AbortSignal;
    beforeDispatch: (route: RemoteUtilityRoute) => Promise<boolean>;
  }): Promise<UtilityTextResult>;
}
export interface RemoteUtilityHost {
  handle(caller: string, raw: unknown): Promise<RemoteUtilityResponse>;
  abortController(caller: string, scope?: RemoteUtilityScope): void;
  abortAll(scope?: RemoteUtilityScope): void;
  revalidateModelAccess(): Promise<void>;
  /**
   * Outbox-resend gate only: apply to queued results, never to the first live send.
   * A false answer means the caller no longer holds the captured owner/epoch/permission
   * (or cancelled the operation), so the stored payload must not be replayed. It reads
   * only the injected synchronous snapshot; it is not a second authorization store.
   */
  resultIsCurrent(caller: string, result: RemoteUtilityResponse): boolean;
}
type Active = { caller: string; snapshot: RemoteUtilitySnapshot; route: RemoteUtilityRoute; controller: AbortController };
type Proof = { caller: string; snapshot: RemoteUtilitySnapshot; route?: RemoteUtilityRoute; operationKey?: string; generation: number };
const LIMIT = 1024;
const CANCEL_TTL_MS = REMOTE_UTILITY_TEXT_MAX_TIMEOUT_MS;
const sameScope = (a: RemoteUtilityScope, b: RemoteUtilityScope) => a.owner === b.owner && a.hostEpoch === b.hostEpoch;
const sameSnapshot = (a: RemoteUtilitySnapshot | null, b: RemoteUtilitySnapshot) => !!a && sameScope(a, b) && a.authorizationEpoch === b.authorizationEpoch;
const sameRoute = (a: RemoteUtilityRoute, b: RemoteUtilityRoute) => a.providerId === b.providerId && a.agentKind === b.agentKind && a.model === b.model;
const keyFor = (scope: RemoteUtilityScope, caller: string, requestId: string) => JSON.stringify([scope.owner, scope.hostEpoch, caller, requestId]);
const error = (code: RemoteUtilityError): RemoteUtilityResponse => ({ version: 1, op: 'error', ok: false, code });

/** Executes only explicit routes. The transport owns deduplication and result retention. */
export function createRemoteUtilityHost(deps: RemoteUtilityHostDeps): RemoteUtilityHost {
  const active = new Map<string, Set<Active>>();
  const cancelled = new Map<string, { scope: RemoteUtilityScope; caller: string; timer: ReturnType<typeof setTimeout> }>();
  // Proof lifetime follows the outbox's response object, not a second result cache.
  const proofs = new WeakMap<RemoteUtilityResponse, Proof>();
  let generation = 0;
  const current = (caller: string, snapshot: RemoteUtilitySnapshot, route?: RemoteUtilityRoute) => sameSnapshot(deps.current(caller, route), snapshot);
  const register = (response: RemoteUtilityResponse, proof: Proof): RemoteUtilityResponse => {
    proofs.set(response, proof);
    return response;
  };
  const removeMarker = (key: string) => {
    const marker = cancelled.get(key);
    if (marker) clearTimeout(marker.timer);
    cancelled.delete(key);
  };
  const clearScope = (scope?: RemoteUtilityScope, caller?: string) => {
    for (const entries of active.values()) for (const entry of entries) {
      if ((!scope || sameScope(scope, entry.snapshot)) && (!caller || caller === entry.caller)) entry.controller.abort();
    }
    for (const [key, marker] of cancelled) {
      if ((!scope || sameScope(scope, marker.scope)) && (!caller || caller === marker.caller)) removeMarker(key);
    }
  };
  const canUse = async (caller: string, snapshot: RemoteUtilitySnapshot, route: RemoteUtilityRoute): Promise<boolean> => {
    if (!current(caller, snapshot, route)) return false;
    const routes = await deps.allowedRoutes(caller);
    return current(caller, snapshot, route) && routes.some((candidate) => sameRoute(candidate, route));
  };
  const failure: () => UtilityTextResult = () => ({ ok: false, reason: 'timeout', attempts: [] });

  return {
    async handle(caller, raw) {
      let request;
      try { request = parseRemoteUtilityRequest(raw); } catch { return error('INVALID_REQUEST'); }
      let snapshot: RemoteUtilitySnapshot | null;
      try { snapshot = deps.current(caller, request.op === 'run' ? request.route : undefined); } catch { return error('UNAUTHORIZED'); }
      if (!snapshot) return error('UNAUTHORIZED');
      // Copy ports' snapshots: a mutable external object must not rewrite our captured identity.
      snapshot = { ...snapshot };
      const proof: Proof = { caller, snapshot, generation };
      if (request.op !== 'caps' && request.hostEpoch !== snapshot.hostEpoch) return register(error('STALE_HOST'), proof);
      if (request.op === 'cancel') {
        const key = keyFor(snapshot, caller, request.requestId);
        const entries = active.get(key);
        if (!cancelled.has(key)) {
          if (cancelled.size >= LIMIT) return register(error('BUSY'), proof);
          const timer = setTimeout(() => removeMarker(key), CANCEL_TTL_MS);
          timer.unref?.();
          cancelled.set(key, { scope: snapshot, caller, timer });
        }
        for (const entry of entries ?? []) entry.controller.abort();
        return register({ version: 1, op: 'cancel', ok: true, requestId: request.requestId }, proof);
      }
      if (request.op === 'caps') {
        try {
          const routes = await deps.allowedRoutes(caller);
          if (!current(caller, snapshot) || proof.generation !== generation) return register(error('UNAUTHORIZED'), proof);
          const response = parseRemoteUtilityResponse({ version: 1, op: 'caps', ok: true, hostEpoch: snapshot.hostEpoch, allowedRoutes: routes });
          if (response.op !== 'caps') return register(error('INVALID_RESPONSE'), proof);
          return register(response, proof);
        } catch { return register(error('EXECUTION_FAILED'), proof); }
      }
      const key = keyFor(snapshot, caller, request.requestId);
      proof.route = request.route;
      proof.operationKey = key;
      if (cancelled.has(key)) return register(error('CANCELLED'), proof);
      const controller = new AbortController();
      const entry: Active = { caller, snapshot, route: request.route, controller };
      const entries = active.get(key) ?? new Set<Active>();
      entries.add(entry);
      active.set(key, entries);
      let timedOut = false;
      try {
        const result = await requestUtilityTextWithinTimeout(async (signal) => {
          if (signal.aborted || !(await canUse(caller, snapshot!, request.route)) || signal.aborted || proof.generation !== generation) return { ok: false, reason: 'no_candidate', attempts: [] };
          return deps.execute(request.prompt, {
            ...request.options, ...request.route, signal,
            beforeDispatch: async (actual) => !signal.aborted && proof.generation === generation && sameRoute(actual, request.route) && await canUse(caller, snapshot!, request.route) && !signal.aborted && proof.generation === generation,
          });
        }, request.options.timeoutMs ?? REMOTE_UTILITY_TEXT_MAX_TIMEOUT_MS, controller.signal, () => {
          timedOut = true;
          return failure();
        });
        if (!current(caller, snapshot, request.route) || proof.generation !== generation) return register(error('UNAUTHORIZED'), proof);
        if (controller.signal.aborted || cancelled.has(key)) return register(error('CANCELLED'), proof);
        if (timedOut) return register({ version: 1, op: 'run', ok: true, requestId: request.requestId, result: failure() }, proof);
        if (!(await canUse(caller, snapshot, request.route)) || proof.generation !== generation) return register(error('ROUTE_UNAVAILABLE'), proof);
        if (controller.signal.aborted || cancelled.has(key)) return register(error('CANCELLED'), proof);
        try {
          return register(parseRemoteUtilityResponse({ version: 1, op: 'run', ok: true, requestId: request.requestId, result }), proof);
        } catch { return register(error('INVALID_RESPONSE'), proof); }
      } catch {
        return register(error('EXECUTION_FAILED'), proof);
      } finally {
        entries.delete(entry);
        if (entries.size === 0 && active.get(key) === entries) active.delete(key);
      }
    },
    abortController(caller, scope) {
      const captured = scope ?? deps.current(caller);
      if (captured) clearScope(captured, caller);
    },
    abortAll(scope) {
      if (!scope) generation++;
      clearScope(scope);
    },
    async revalidateModelAccess() {
      await Promise.all([...active.values()].flatMap((entries) => [...entries]).map(async (entry) => {
        try { if (!(await canUse(entry.caller, entry.snapshot, entry.route))) entry.controller.abort(); }
        catch { entry.controller.abort(); }
      }));
    },
    resultIsCurrent(caller, result) {
      const proof = proofs.get(result);
      // Deny by default: only responses this host produced carry live ownership metadata.
      if (!proof) return false;
      try {
        if (proof.caller !== caller || proof.generation !== generation || !current(caller, proof.snapshot, proof.route)) return false;
        if (result.op === 'run' && proof.operationKey && cancelled.has(proof.operationKey)) return false;
        return current(caller, proof.snapshot, proof.route) && proof.generation === generation;
      } catch { return false; }
    },
  };
}
