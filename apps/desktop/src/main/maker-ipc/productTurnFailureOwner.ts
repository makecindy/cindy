import type { AgentEvent, Session } from '@cindy/maker-core';

const MAX_FINGERPRINT_CHARS = 2048;

function boundedScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value.slice(0, MAX_FINGERPRINT_CHARS);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Existing error/meta fields correlate a deferred recovery receipt without adding wire data. */
export interface ProductTurnFailureReceipt {
  readonly data?: unknown;
  readonly meta?: unknown;
}

export interface ProductTurnFailureFingerprint {
  readonly error: string;
  readonly meta: string | null;
}

export function fingerprintProductTurnFailure(
  receipt: ProductTurnFailureReceipt,
): ProductTurnFailureFingerprint {
  const data = recordOf(receipt.data);
  const meta = recordOf(receipt.meta);
  const error = JSON.stringify([
    boundedScalar(data?.message),
    boundedScalar(data?.reason),
    boundedScalar(data?.sdkError),
    boundedScalar(data?.errorStatus),
  ]);
  const metaValues = [
    boundedScalar(meta?.uuid),
    boundedScalar(meta?.requestId),
    boundedScalar(meta?.sdkSessionId),
  ];
  return {
    error,
    meta: metaValues.some((value) => value !== null) ? JSON.stringify(metaValues) : null,
  };
}

/**
 * Identity captured at the terminal boundary that owns a deferred product
 * failure. Session ids can be reused by a replacement runtime, and a single
 * Session can execute several provider turns, so the id alone is not enough
 * to safely run a late callback.
 */
export interface ProductTurnFailureOwner {
  readonly session: Session;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly fingerprint: ProductTurnFailureFingerprint;
}

export function captureProductTurnFailureOwner(
  session: Session,
  event: AgentEvent,
  agentMeta?: unknown,
): ProductTurnFailureOwner {
  return {
    session,
    sessionId: session.id,
    instanceId:
      typeof event.sessionInstanceId === 'string' && event.sessionInstanceId.length > 0
        ? event.sessionInstanceId
        : session.instanceId,
    generation:
      typeof event.sessionTurnGeneration === 'number'
        ? event.sessionTurnGeneration
        : session.getTurnGeneration(),
    fingerprint: fingerprintProductTurnFailure({
      data: event.data,
      meta: agentMeta ?? (event as AgentEvent & { agentMeta?: unknown }).agentMeta,
    }),
  };
}

export interface DeferredProductTurnFailureGate {
  /** Register the newest deferred failure for a session. */
  defer(owner: ProductTurnFailureOwner): void;
  /** Remove only the exact owner captured by a terminal boundary. */
  clear(owner: ProductTurnFailureOwner): void;
  /** Remove owners belonging to a replaced Session instance. */
  clearSession(sessionId: string, session?: Session): void;
  /** Transfer a logical recovery owner to a replacement runtime for the same task. */
  rebindSession(sessionId: string, session: Session): void;
  /**
   * Consume a deferred failure only when the caller proves that its owner is
   * still current. The callback is called at most once for that owner.
   */
  settle(
    sessionId: string,
    isCurrent: (owner: ProductTurnFailureOwner) => boolean,
    callback: (owner: ProductTurnFailureOwner) => void,
    receipt?: ProductTurnFailureReceipt,
  ): boolean;
  /** Exposed for focused unit tests and diagnostics; callers must not mutate it. */
  pending(sessionId: string): ProductTurnFailureOwner | undefined;
}

function sameOwner(a: ProductTurnFailureOwner, b: ProductTurnFailureOwner): boolean {
  return (
    a.session === b.session &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId &&
    a.generation === b.generation
  );
}

export function createDeferredProductTurnFailureGate(): DeferredProductTurnFailureGate {
  const pendingOwners = new Map<string, ProductTurnFailureOwner[]>();

  const removeOwner = (
    sessionId: string,
    predicate: (owner: ProductTurnFailureOwner) => boolean,
  ): void => {
    const owners = pendingOwners.get(sessionId);
    if (!owners) return;
    const remaining = owners.filter((owner) => !predicate(owner));
    if (remaining.length) pendingOwners.set(sessionId, remaining);
    else pendingOwners.delete(sessionId);
  };

  return {
    defer(owner) {
      const owners = pendingOwners.get(owner.sessionId) ?? [];
      if (!owners.some((pending) => sameOwner(pending, owner))) owners.push(owner);
      pendingOwners.set(owner.sessionId, owners);
    },
    clear(owner) {
      removeOwner(owner.sessionId, (pending) => sameOwner(pending, owner));
    },
    clearSession(sessionId, session) {
      if (session === undefined) pendingOwners.delete(sessionId);
      else removeOwner(sessionId, (pending) => pending.session === session);
    },
    rebindSession(sessionId, session) {
      const owners = pendingOwners.get(sessionId);
      if (!owners) return;
      pendingOwners.set(
        sessionId,
        owners.map((pending) =>
          pending.session === session
            ? pending
            : {
                ...pending,
                session,
                instanceId: session.instanceId,
                generation: session.getTurnGeneration(),
              },
        ),
      );
    },
    settle(sessionId, isCurrent, callback, receipt) {
      const owners = pendingOwners.get(sessionId);
      if (!owners?.length) return false;
      let candidates = owners;
      if (receipt) {
        const fingerprint = fingerprintProductTurnFailure(receipt);
        candidates = owners.filter((owner) => {
          if (owner.fingerprint.error !== fingerprint.error) return false;
          return fingerprint.meta === null || owner.fingerprint.meta === fingerprint.meta;
        });
      }
      // Without a wire token, identical failures are ambiguous. Fail closed instead
      // of allowing an old receipt to interrupt a newer product turn.
      if (candidates.length !== 1) return false;
      const pending = candidates[0];
      // Consume stale ownership as well. A late IPC acknowledgement must not
      // remain armed until a later, unrelated turn happens to reuse the id.
      removeOwner(sessionId, (owner) => sameOwner(owner, pending));
      if (!isCurrent(pending)) return false;
      callback(pending);
      return true;
    },
    pending(sessionId) {
      return pendingOwners.get(sessionId)?.[0];
    },
  };
}
