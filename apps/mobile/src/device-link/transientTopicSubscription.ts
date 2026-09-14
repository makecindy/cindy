import { withTransientRemoteRetry } from '@/device-link/remoteRetry';

type RetryOperation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface TransientTopicSubscriptionRequest {
  /** Same recovery scope shares one retry loop; a new connection/session gets a new identity. */
  identity: string;
  /** Stops an old loop after route, connection epoch, or mounted-screen ownership changes. */
  isStale(): boolean;
  /** Rebuild the peer link before retrying a subscription that already failed once. */
  reopenLink(): Promise<void>;
  /** Register the local owner and wait for the remote subscription acknowledgement. */
  subscribe(): Promise<void>;
}

export interface TransientTopicSubscriptionCoordinator {
  start(request: TransientTopicSubscriptionRequest): Promise<void>;
}

/**
 * Runs topic subscription recovery independently from snapshot reads.
 *
 * One recovery identity owns at most one physical retry loop. The first attempt
 * reuses the link already prepared by the caller; later attempts reopen the
 * peer link before subscribing again. Final failure is intentionally contained:
 * snapshots remain usable even when the live topic cannot be restored yet.
 */
export function createTransientTopicSubscriptionCoordinator(
  retry: RetryOperation = withTransientRemoteRetry,
): TransientTopicSubscriptionCoordinator {
  const inFlight = new Map<string, {
    isStale(): boolean;
    task: Promise<void>;
  }>();

  return {
    start(request): Promise<void> {
      const current = inFlight.get(request.identity);
      if (current && !current.isStale()) return current.task;

      let subscribeAttempted = false;
      const task = retry(async () => {
        if (request.isStale()) return;
        if (subscribeAttempted) {
          await request.reopenLink();
          if (request.isStale()) return;
        }
        subscribeAttempted = true;
        await request.subscribe();
      }).catch(() => undefined);

      const entry = { isStale: request.isStale, task };
      inFlight.set(request.identity, entry);
      void task.finally(() => {
        if (inFlight.get(request.identity) === entry) {
          inFlight.delete(request.identity);
        }
      });
      return task;
    },
  };
}
