/** IPC bridge signature used by Electron's `ipcRenderer.on`. */
export type BufferedIpcBridge = (event: unknown, data: unknown, ownerStamp?: unknown) => void;

type IpcCallback = (data: unknown, ownerStamp?: unknown) => void;

export interface BufferedIpcFanOutOptions {
  /** Maximum number of events retained while no renderer subscriber exists. */
  maxBufferedEvents: number;
  /** Events older than this are never replayed to a later subscriber. */
  ttlMs: number;
  /** Test seam; production callers use `Date.now`. */
  now?: () => number;
}

export type BufferedIpcFanOut = ((callback: IpcCallback) => () => void) & {
  /** Test/HMR escape hatch: clear state and remove the underlying IPC listener. */
  __reset: () => void;
};

interface BufferedEvent {
  data: unknown;
  ownerStamp: unknown;
  receivedAt: number;
}

/**
 * Eager, ref-count-independent IPC fan-out with a bounded in-memory backlog.
 *
 * Unlike the ordinary lazy fan-out in `preload.ts`, the bridge is bound as soon
 * as preload evaluates and remains bound after the last renderer listener
 * leaves. This closes the short window between an IPC push and the renderer
 * subscription being mounted (initial load, route transition, or window
 * detach). Buffered entries are delivered once to the first later subscriber.
 */
export function createBufferedIpcFanOut(
  bind: (bridge: BufferedIpcBridge) => () => void,
  options: BufferedIpcFanOutOptions,
): BufferedIpcFanOut {
  const { maxBufferedEvents, ttlMs, now = Date.now } = options;
  if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
    throw new RangeError('maxBufferedEvents must be a positive integer');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive finite number');
  }

  const listeners = new Set<IpcCallback>();
  let backlog: BufferedEvent[] = [];
  let unbind: (() => void) | null = null;

  const pruneExpired = (currentTime: number): void => {
    const cutoff = currentTime - ttlMs;
    backlog = backlog.filter((entry) => entry.receivedAt >= cutoff);
  };

  const bridge: BufferedIpcBridge = (_event, data, ownerStamp) => {
    if (listeners.size > 0) {
      listeners.forEach((callback) => callback(data, ownerStamp));
      return;
    }

    const receivedAt = now();
    pruneExpired(receivedAt);
    backlog.push({ data, ownerStamp, receivedAt });
    if (backlog.length > maxBufferedEvents) {
      backlog.splice(0, backlog.length - maxBufferedEvents);
    }
  };

  const ensureBound = (): void => {
    if (!unbind) unbind = bind(bridge);
  };
  ensureBound();

  const subscribe = ((callback: IpcCallback): (() => void) => {
    ensureBound();
    listeners.add(callback);

    pruneExpired(now());
    if (backlog.length > 0) {
      const pending = backlog;
      backlog = [];
      for (const entry of pending) callback(entry.data, entry.ownerStamp);
    }

    return () => {
      listeners.delete(callback);
      // Intentionally keep the eager IPC bridge bound so pushes that arrive
      // between route subscribers are buffered instead of silently discarded.
    };
  }) as BufferedIpcFanOut;

  subscribe.__reset = (): void => {
    listeners.clear();
    backlog = [];
    unbind?.();
    unbind = null;
  };

  return subscribe;
}
