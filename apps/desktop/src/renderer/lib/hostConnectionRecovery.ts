import type { HostConnectionApi, HostConnectionState } from '@cindy/maker-shared/host-event-stream';

export type HostRecoveryView = HostConnectionState & { restoring: boolean; failed: boolean };

/** Connection-scoped snapshot recovery. Only reads are retried; task mutations
 * remain owned by the user's original action and the existing input queue. */
export function observeHostRecovery(input: {
  api: HostConnectionApi;
  recover: (isCurrent: () => boolean) => Promise<void>;
  onView: (view: HostRecoveryView) => void;
}) {
  let state: HostConnectionState | undefined;
  let completed = 0;
  let epoch = 0;
  let disposed = false;
  let running = false;
  let failed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => { if (state && !disposed) input.onView({ ...state, restoring: running, failed }); };
  const clearRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const recover = async () => {
    if (disposed || running || state?.status !== 'connected' || state.recovery <= completed) return;
    clearRetry();
    const ticket = ++epoch;
    const target = state.recovery;
    const current = () => !disposed && ticket === epoch && state?.status === 'connected';
    running = true;
    failed = false;
    emit();
    try {
      await input.recover(current);
      if (current()) completed = target;
    } catch {
      if (current()) {
        failed = true;
        retryTimer = setTimeout(() => { retryTimer = undefined; void recover(); }, 2_000);
      }
    } finally {
      if (current()) { running = false; emit(); }
    }
  };
  const unsubscribe = input.api.onStateChanged(next => {
    if (state?.connection === next.connection && state.status === next.status && state.recovery === next.recovery) return;
    state = next;
    ++epoch;
    running = false;
    failed = false;
    clearRetry();
    emit();
    void recover();
  });
  return {
    retry() {
      if (state?.status === 'connected' && !running) void recover();
      else input.api.retry();
    },
    dispose() { disposed = true; ++epoch; clearRetry(); unsubscribe(); },
  };
}
