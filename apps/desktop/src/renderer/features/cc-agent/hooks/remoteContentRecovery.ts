export type RemoteContentRecoveryState = 'syncing' | 'ready';

/** A view's recovery is complete only after its subscription ACK and a snapshot
 * actually applied. The existing transport owns reconnect; this owns no links. */
export function createRemoteContentRecovery(deps: {
  subscribe(): Promise<unknown>;
  reconcile(): Promise<boolean>;
  changed(state: RemoteContentRecoveryState): void;
  completed(elapsedMs: number): void;
  phaseCompleted?(phase: 'subscription' | 'snapshot', elapsedMs: number): void;
  now?: () => number;
  retryMs?: number;
}) {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let available = true;
  let disposed = false;
  let ready = false;
  let inFlight: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let startedAt = now();
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const request = (): void => {
    if (disposed || !available || ready || inFlight !== null) return;
    clearTimer();
    const current = generation;
    inFlight = current;
    void (async () => {
      try {
        const subscribeAt = now();
        await deps.subscribe();
        if (disposed || generation !== current || !available) return;
        deps.phaseCompleted?.('subscription', Math.max(0, now() - subscribeAt));
        const snapshotAt = now();
        const applied = await deps.reconcile();
        if (disposed || generation !== current || !available || !applied) return;
        deps.phaseCompleted?.('snapshot', Math.max(0, now() - snapshotAt));
        ready = true;
        attempt = 0;
        deps.changed('ready');
        deps.completed(Math.max(0, now() - startedAt));
      } catch {
        // Errors stay visible through the existing connection/error surfaces.
        // Failure must never be translated into a successful content recovery.
      } finally {
        inFlight = null;
        if (disposed || !available || ready) return;
        if (generation !== current) {
          request();
          return;
        }
        timer = setTimeout(
          () => {
            timer = null;
            request();
          },
          Math.min((deps.retryMs ?? 3_000) * 2 ** Math.min(attempt++, 4), 30_000),
        );
      }
    })();
  };
  return {
    request,
    isReady: () => ready,
    invalidate(nextAvailable: boolean) {
      if (disposed) return;
      generation++;
      available = nextAvailable;
      ready = false;
      attempt = 0;
      startedAt = now();
      clearTimer();
      deps.changed('syncing');
    },
    dispose() {
      disposed = true;
      generation++;
      clearTimer();
    },
  };
}
