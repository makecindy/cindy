/**
 * Session-scoped interaction routing.
 *
 * Maker Session exposes a single replaceable interaction listener. Desktop,
 * direct IM and hook-control used to overwrite that listener for each turn and
 * later "restore" the previous surface. The router owns the listener for the
 * lifetime of a Session instance; turn producers only register an active route.
 */

import type {
  InteractionDecision,
  InteractionRequest,
  TurnPermissionOrigin,
} from '@cindy/maker-core';
import { createSharedPermission, type SharedPermission } from './sharedPermission';

export type TurnOrigin = TurnPermissionOrigin;

export type InteractionSurface = 'desktop' | 'channel-card' | 'headless';
export type InteractionRouteState = 'waiting' | 'resolved' | 'cancelled';

export interface InteractionRoute {
  sessionId: string;
  turnId: string;
  origin: TurnOrigin;
  interactionSurface: InteractionSurface;
  timeoutMs?: number;
  /** Main-owned source text, shared by Desktop and channel presentations. */
  sourceDescription?: string;
  onStateChange?(state: InteractionRouteState): void;
}

export type InteractionHandler = (
  request: InteractionRequest,
  permission?: SharedPermission,
) => Promise<InteractionDecision>;

export interface InteractionLifecycleObserver {
  onStart(request: InteractionRequest, route?: InteractionRoute): void;
  onEnd(request: InteractionRequest, route?: InteractionRoute): void;
}

export interface InteractionSession {
  readonly id: string;
  setInteractionListener(listener: InteractionHandler | null): void;
}

type RouteRegistration =
  | {
      route: InteractionRoute & { interactionSurface: 'desktop' };
      handle?: never;
      onCancel?: (requestId: string, decision: InteractionDecision) => boolean | void;
    }
  | {
      route: InteractionRoute & { interactionSurface: 'channel-card' | 'headless' };
      handle: InteractionHandler;
      /** Apply existing channel restrictions before exposing a Desktop mirror. */
      permissionGuard?: (request: Extract<InteractionRequest, { kind: 'permission' }>) => InteractionDecision | null;
      /**
       * Return true when the routed surface resolved its own handler promise.
       * Otherwise the router resolves the request with its kind-correct fallback.
       */
      onCancel?: (requestId: string, decision: InteractionDecision) => boolean | void;
    };

type ActiveRoute = RouteRegistration & { token: symbol };

interface PendingRequest {
  shared?: SharedPermission;
  routeToken: symbol | null;
  request: InteractionRequest;
  cancel(decision: InteractionDecision): void;
}

export interface InteractionRouteLease {
  readonly route: InteractionRoute;
  release(reason?: string): void;
}

function callSafely<T>(callback: () => T): T | undefined {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

function safeDecision(
  request: InteractionRequest,
  reason: string,
): InteractionDecision {
  if (request.kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {} };
  }
  if (request.kind === 'plan_review') {
    return {
      kind: 'plan_review',
      behavior: 'deny',
      reason,
      dismissed: true,
    };
  }
  return { kind: 'permission', behavior: 'deny', reason };
}

class SessionInteractionRouter {
  private desktopHandler: InteractionHandler | null = null;
  private desktopCancel: ((requestId: string, decision: InteractionDecision) => void) | undefined;
  private lifecycleObserver: InteractionLifecycleObserver | null = null;
  private activeRoute: ActiveRoute | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly session: InteractionSession) {
    session.setInteractionListener((request) => this.dispatch(request));
  }

  setDesktopHandler(handler: InteractionHandler, cancel?: (requestId: string, decision: InteractionDecision) => void): void {
    this.desktopHandler = handler;
    this.desktopCancel = cancel;
  }

  setLifecycleObserver(observer: InteractionLifecycleObserver | null): void {
    this.lifecycleObserver = observer;
  }

  private notifyState(route: InteractionRoute | undefined, state: InteractionRouteState): void {
    callSafely(() => route?.onStateChange?.(state));
  }

  private notifyLifecycle(
    phase: keyof InteractionLifecycleObserver,
    request: InteractionRequest,
    route?: InteractionRoute,
  ): void {
    callSafely(() => this.lifecycleObserver?.[phase](request, route));
  }

  begin(registration: RouteRegistration): InteractionRouteLease {
    if (registration.route.sessionId !== this.session.id) {
      throw new Error(
        `interaction route session mismatch: expected=${this.session.id} actual=${registration.route.sessionId}`,
      );
    }
    if (this.activeRoute) {
      throw new Error(
        `interaction route already active for session=${this.session.id} turn=${this.activeRoute.route.turnId}`,
      );
    }
    const active: ActiveRoute = {
      ...registration,
      token: Symbol(registration.route.turnId),
    };
    this.activeRoute = active;
    let released = false;
    return {
      route: registration.route,
      release: (reason = 'interaction_route_released') => {
        if (released) return;
        released = true;
        if (this.activeRoute?.token !== active.token) return;
        this.activeRoute = null;
        for (const [requestId, pending] of this.pending) {
          if (pending.routeToken !== active.token) continue;
          const decision = safeDecision(pending.request, reason);
          if (pending.shared) pending.cancel(decision);
          const handledBySurface = callSafely(
            () => active.onCancel?.(requestId, decision) === true,
          ) === true;
          if (!pending.shared && !handledBySurface) pending.cancel(decision);
        }
      },
    };
  }

  async dispatch(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionDecision> {
    if (signal?.aborted) return safeDecision(request, 'session_aborted');
    if (this.pending.has(request.requestId)) {
      return safeDecision(request, 'duplicate_request_id');
    }

    const active = this.activeRoute;
    if (request.kind === 'permission' && active?.route.sourceDescription) {
      request = { ...request,
        metadata: { ...request.metadata, imSourceDescription: active.route.sourceDescription },
        description: [active.route.sourceDescription, request.description].filter(Boolean).join('\n\n'),
      };
    }
    const handler =
      active?.route.interactionSurface === 'desktop'
        ? this.desktopHandler
        : active?.handle ?? this.desktopHandler;
    if (!handler) return safeDecision(request, 'no_interaction_route');
    if (request.kind === 'permission' && active?.route.interactionSurface !== 'desktop' && active && 'permissionGuard' in active) {
      try {
        const blocked = active.permissionGuard?.(request);
        if (blocked) return blocked;
      } catch {
        return safeDecision(request, 'interaction_handler_failed');
      }
    }

    // Desktop-only confirmations retain their existing boundary. Every IM
    // channel using this router automatically shares ordinary tool permissions.
    const shared = request.kind === 'permission' && active?.route.interactionSurface === 'channel-card'
      ? createSharedPermission() : undefined;

    let cancel!: (decision: InteractionDecision) => void;
    let cancelledByRouter = false;
    const cancelled = new Promise<InteractionDecision>((resolve) => {
      cancel = (decision) => {
        cancelledByRouter = true;
        shared?.settle(decision);
        resolve(decision);
      };
    });
    this.pending.set(request.requestId, {
      shared,
      routeToken: active?.token ?? null,
      request,
      cancel,
    });
    const abort = () => {
      const decision = safeDecision(request, 'session_aborted');
      cancel(decision);
      if (active?.route.interactionSurface === 'channel-card' || active?.route.interactionSurface === 'headless') {
        callSafely(() => active.onCancel?.(request.requestId, decision));
      } else {
        callSafely(() => this.desktopCancel?.(request.requestId, decision));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.notifyLifecycle('onStart', request, active?.route);
    this.notifyState(active?.route, 'waiting');
    const timeoutMs = active?.route.timeoutMs;
    const timeout =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            const decision = safeDecision(request, 'interaction_timeout');
            if (shared) {
              shared.decide(decision);
              return;
            }
            const handledBySurface = callSafely(
              () => active?.onCancel?.(request.requestId, decision) === true,
            ) === true;
            if (!handledBySurface) cancel(decision);
          }, timeoutMs)
        : null;

    try {
      let handled: Promise<InteractionDecision>;
      if (shared) {
        // Install the Host pause boundary before a channel can synchronously answer.
        const surfaces = this.desktopHandler ? [this.desktopHandler, handler] : [handler];
        let failed = 0;
        const fail = () => {
          if (++failed === surfaces.length) shared.decide(safeDecision(request, 'interaction_handler_failed'));
        };
        for (const surface of surfaces) {
          try { void surface(request, shared).then(shared.decide, fail); }
          catch { fail(); }
        }
        handled = shared.result;
      } else {
        handled = handler(request);
      }
      if (signal?.aborted) abort();
      const decision = await Promise.race([shared?.result ?? handled, cancelled]);
      this.notifyState(
        active?.route,
        !cancelledByRouter && this.activeRoute?.token === active?.token
          ? 'resolved'
          : 'cancelled',
      );
      return decision;
    } catch {
      this.notifyState(active?.route, 'cancelled');
      return safeDecision(request, 'interaction_handler_failed');
    } finally {
      signal?.removeEventListener('abort', abort);
      if (timeout) clearTimeout(timeout);
      this.pending.delete(request.requestId);
      this.notifyLifecycle('onEnd', request, active?.route);
    }
  }
}

const routers = new WeakMap<object, SessionInteractionRouter>();

function routerFor(session: InteractionSession): SessionInteractionRouter {
  const key = session as object;
  let router = routers.get(key);
  if (!router) {
    router = new SessionInteractionRouter(session);
    routers.set(key, router);
  }
  return router;
}

/** Register/update the Desktop fallback without replacing Session's listener. */
export function installDesktopInteractionHandler(
  session: InteractionSession,
  handler: InteractionHandler,
  cancel?: (requestId: string, decision: InteractionDecision) => void,
): void {
  routerFor(session).setDesktopHandler(handler, cancel);
}

/** Host permissions use the same UI, remote responses and route lease as Agent permissions. */
export function requestHostInteraction(
  session: InteractionSession,
  request: InteractionRequest,
  signal: AbortSignal,
): Promise<InteractionDecision> {
  return routerFor(session).dispatch(request, signal);
}

export function installInteractionLifecycleObserver(
  session: InteractionSession,
  observer: InteractionLifecycleObserver | null,
): void {
  routerFor(session).setLifecycleObserver(observer);
}

/**
 * Activate a non-Desktop route after Session's busy guard has admitted the
 * turn. A second live route is rejected so the provider cannot start with an
 * ambiguous interaction destination.
 */
export function beginInteractionRoute(
  session: InteractionSession,
  registration: RouteRegistration,
): InteractionRouteLease {
  return routerFor(session).begin(registration);
}
