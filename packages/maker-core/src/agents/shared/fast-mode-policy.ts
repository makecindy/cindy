import type { AgentSessionHandle } from '../base-agent.js';

/** Only the trusted host supplies this policy; functions never cross device-link. */
export interface FastModePolicy {
  isAllowed(): boolean;
  subscribe(listener: () => Promise<void>): () => void;
  /** Keeps a native turn's stale Fast payload suppressed after a restriction is lifted. */
  isRequestAllowed?(): boolean;
  onFastModeChanged?(enabled: boolean | 'ultrafast'): void;
}

/** Native engines can retain a turn's speed through tool loops. Enforce again at the trusted HTTP/WS exit. */
export function standardSpeedRequest(body: unknown): unknown | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  // Responses WebSocket control events are not inference requests. Unknown
  // speed fields can invalidate otherwise valid session/cancel/item frames.
  if (typeof record.type === 'string' && record.type !== 'response.create') return null;
  const next: Record<string, unknown> = { ...record };
  if (Array.isArray(record.messages)) {
    next.speed = 'standard';
    if ('service_tier' in record) next.service_tier = 'standard_only';
  } else next.service_tier = 'default';
  if ('speed' in record) next.speed = 'standard';
  if ('serviceTier' in record) next.serviceTier = null;
  if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
    next.response = standardSpeedRequest(record.response);
  }
  return next;
}

/**
 * Serialize native updates with user changes. Checking inside the queue prevents a
 * late Fast enable from overtaking a prohibition. Allowing Fast again never enables it.
 */
export function withFastModePolicy(
  handle: AgentSessionHandle,
  policy?: FastModePolicy,
): AgentSessionHandle {
  if (!policy) return handle;
  let pending = Promise.resolve();
  let closed = false;
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    pending = pending.catch(() => undefined).then(work);
    return pending;
  };
  const enforce = () =>
    enqueue(async () => {
      if (!closed && !policy.isAllowed()) {
        policy.onFastModeChanged?.(false);
        if (!handle.setFastMode)
          throw new Error('Subscription Fast policy is not supported by this agent');
        await handle.setFastMode(false);
      }
    });
  const off = policy.subscribe(enforce);
  // Policy may have tightened while the native process was starting.
  if (!policy.isAllowed()) void enforce().catch(() => undefined);
  const guarded = new Set(['send', 'steer', 'setModel', 'compactSession']);
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'getFastMode')
        return () =>
          (policy.isRequestAllowed?.() ?? policy.isAllowed())
            ? (target.getFastMode?.() ?? false)
            : false;
      if (key === 'setFastMode')
        return (enabled: boolean | 'ultrafast') =>
          enqueue(async () => {
            if (closed) return;
            if (!target.setFastMode)
              throw new Error('Subscription Fast policy is not supported by this agent');
            const effective = policy.isAllowed() ? enabled : false;
            if (!effective) policy.onFastModeChanged?.(false);
            await target.setFastMode(effective);
            policy.onFastModeChanged?.(
              policy.isAllowed() ? (target.getFastMode?.() ?? effective) : false,
            );
          });
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'close')
        return async (...args: unknown[]) => {
          closed = true;
          off();
          await pending.catch(() => undefined);
          return Reflect.apply(value, target, args);
        };
      if (guarded.has(String(key)))
        return async (...args: unknown[]) => {
          await enforce();
          const result = await Reflect.apply(value, target, args);
          if (key === 'setModel') await enforce();
          return result;
        };
      return value.bind(target);
    },
  });
}
