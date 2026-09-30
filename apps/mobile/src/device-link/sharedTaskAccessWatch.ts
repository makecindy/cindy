import { ApiError } from '@/api/client';

/** Only an authoritative missing membership ends access; network failures do not. */
export function isSharedTaskGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND';
}

/** Reconcile an open guest task when the relay can no longer route its revoke frame. */
export function watchSharedTaskAccess(options: {
  sharedTaskId: string;
  sessionId: string;
  read(): Promise<{ sharedTaskId: string; sessionId: string; status: string }>;
  isCurrent(): boolean;
  onRevoked(): void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !stopped && options.isCurrent();
  const revoke = () => {
    if (!current()) return;
    stopped = true;
    options.onRevoked();
  };
  const check = async () => {
    if (!current()) return;
    try {
      const detail = await options.read();
      if (!current()) return;
      if (detail.sharedTaskId === options.sharedTaskId && detail.sessionId === options.sessionId
          && detail.status === 'closed') revoke();
    } catch (error) {
      // Timeout, offline, expired login and unsupported routes are not revocation.
      if (isSharedTaskGone(error)) revoke();
    } finally {
      // A slow read occupies the only request slot; no interval can pile up reads.
      if (current()) timer = setTimeout(() => void check(), 5_000);
    }
  };
  void check();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
