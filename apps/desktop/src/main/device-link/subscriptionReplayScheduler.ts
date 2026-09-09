import { DeviceLinkError } from '@cindy/device-link';

const PERMANENT_SUBSCRIPTION_REPLAY_CODES: ReadonlySet<string> = new Set([
  'VERSION_MISMATCH',
  'REMOTE_DISABLED',
  'ACCESS_REVOKED',
  'CHANNEL_NOT_ALLOWED',
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_STANDBY',
]);

/** Terminal for this replay; later online/reconnect triggers can start another. */
export function isPermanentSubscriptionReplayError(err: unknown, available: boolean | undefined): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof DeviceLinkError ? err.code : /\[([A-Z_]+)\]/.exec(message)?.[1];
  // Bound the newly enabled unknown-state recovery on an explicit offline result.
  // For known-available peers, preserve the pre-existing transient policy. This
  // cached boolean does not establish event ordering; it may itself be stale.
  // Route/presence reconciliation is outside this unknown-state recovery fix.
  return code !== undefined && (
    PERMANENT_SUBSCRIPTION_REPLAY_CODES.has(code)
    || (code === 'DEVICE_OFFLINE' && available !== true)
  );
}

export type SubscriptionReplayRef = {
  deviceId: string;
  topics: string[];
};

export type SubscriptionReplayScheduler = {
  replay(reason: string, deviceId?: string): void;
  cancel(deviceId: string): void;
  teardown(): void;
};

type Timer = ReturnType<typeof setTimeout>;

type SubscriptionReplaySchedulerOptions = {
  snapshotSubscriptions: (deviceId?: string) => SubscriptionReplayRef[];
  remoteSubscribe: (deviceId: string, topics: string[]) => Promise<unknown>;
  isLinkTornDown: () => boolean;
  isRelayOnline: () => boolean;
  isDeviceUnresponsive: (deviceId: string) => boolean;
  /** undefined means this relay generation has not observed the peer yet. */
  getPresenceAvailability: (deviceId: string) => boolean | undefined;
  isPermanentError: (error: unknown, deviceId: string) => boolean;
  log: {
    debug(message: string): void;
    warn(message: string): void;
  };
  retryBaseMs?: number;
  retryMaxMs?: number;
};

/**
 * Coordinates subscription replay triggers for one relay connection.
 *
 * The scheduler deliberately owns only replay state.  The caller supplies the
 * current subscription snapshot and connection gates, so this logic can be
 * exercised without booting Electron or a real relay.
 */
export function createSubscriptionReplayScheduler(
  options: SubscriptionReplaySchedulerOptions,
): SubscriptionReplayScheduler {
  const retryBaseMs = options.retryBaseMs ?? 3_000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  const retryTimers = new Map<string, Timer>();
  const inFlight = new Map<string, symbol>();
  const pendingReruns = new Map<string, string>();
  const generations = new Map<string, number>();

  const currentGeneration = (deviceId: string): number => generations.get(deviceId) ?? 0;

  const clearTimer = (deviceId: string): void => {
    const timer = retryTimers.get(deviceId);
    if (!timer) return;
    clearTimeout(timer);
    retryTimers.delete(deviceId);
  };

  const replayDevice = (
    deviceId: string,
    topics: string[],
    reason: string,
    attempt: number,
    generation?: number,
  ): void => {
    if (inFlight.has(deviceId)) {
      pendingReruns.set(deviceId, reason);
      return;
    }

    const gen = generation ?? currentGeneration(deviceId) + 1;
    if (generation === undefined) generations.set(deviceId, gen);
    clearTimer(deviceId);

    const requestToken = Symbol(deviceId);
    inFlight.set(deviceId, requestToken);
    void options.remoteSubscribe(deviceId, topics).catch((error: unknown) => {
      if (currentGeneration(deviceId) !== gen) return;
      if (options.isPermanentError(error, deviceId)) {
        options.log.warn(
          `device-link replay subscriptions failed (${reason}) for ${deviceId.slice(0, 8)}, permanent, giving up: ${String(error)}`,
        );
        return;
      }

      const delay = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs);
      options.log.warn(
        `device-link replay subscriptions failed (${reason}) for ${deviceId.slice(0, 8)}, retrying in ${delay}ms: ${String(error)}`,
      );
      const timer = setTimeout(() => {
        retryTimers.delete(deviceId);
        if (currentGeneration(deviceId) !== gen) return;
        if (options.isLinkTornDown() || !options.isRelayOnline()) return;
        if (options.isDeviceUnresponsive(deviceId)) return;
        // Presence is incremental and resets on reconnect. Unknown must keep the
        // existing backoff alive; only an explicit offline/disabled verdict stops it.
        if (options.getPresenceAvailability(deviceId) === false) return;
        const current = options
          .snapshotSubscriptions(deviceId)
          .find((ref) => ref.deviceId === deviceId);
        if (!current || current.topics.length === 0) return;
        replayDevice(deviceId, current.topics, `${reason}-retry`, attempt + 1, gen);
      }, delay);
      timer.unref?.();
      retryTimers.set(deviceId, timer);
    }).finally(() => {
      // A teardown/re-acquire can start a new request before an old one settles.
      // Only the request that registered the token may clear in-flight state.
      if (inFlight.get(deviceId) !== requestToken) return;
      inFlight.delete(deviceId);
      const pendingReason = pendingReruns.get(deviceId);
      if (!pendingReason) return;
      pendingReruns.delete(deviceId);
      if (options.isLinkTornDown() || !options.isRelayOnline()) return;
      replay(pendingReason + '-pending', deviceId);
    });
  };

  const replay = (reason: string, deviceId?: string): void => {
    const refs = options.snapshotSubscriptions(deviceId);
    if (refs.length === 0) return;
    const topicCount = refs.reduce((sum, item) => sum + item.topics.length, 0);
    options.log.debug(
      `device-link replay subscriptions (${reason}): devices=${refs.length} topics=${topicCount}`,
    );
    for (const ref of refs) replayDevice(ref.deviceId, ref.topics, reason, 0);
  };

  const cancel = (deviceId: string): void => {
    generations.set(deviceId, currentGeneration(deviceId) + 1);
    clearTimer(deviceId);
    pendingReruns.delete(deviceId);
  };

  const teardown = (): void => {
    const devices = new Set([
      ...retryTimers.keys(),
      ...inFlight.keys(),
      ...pendingReruns.keys(),
      ...generations.keys(),
    ]);
    for (const deviceId of devices) {
      generations.set(deviceId, currentGeneration(deviceId) + 1);
      clearTimer(deviceId);
      pendingReruns.delete(deviceId);
    }
    inFlight.clear();
  };

  return { replay, cancel, teardown };
}
