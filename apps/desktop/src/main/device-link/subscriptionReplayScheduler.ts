import { DeviceLinkError, PeerRecoveryScheduler } from '@cindy/device-link';

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
  // Reuse Mobile's per-peer serialization, cancellation and retry accounting.
  // The adapter owns only Desktop's subscription snapshot and availability gates.
  const scheduler = new PeerRecoveryScheduler(async (deviceId) => {
    if (options.isLinkTornDown() || !options.isRelayOnline()) return { retry: false };
    if (options.isDeviceUnresponsive(deviceId)) return { retry: false };
    if (options.getPresenceAvailability(deviceId) === false) return { retry: false };
    const current = options.snapshotSubscriptions(deviceId)
      .find((ref) => ref.deviceId === deviceId);
    if (!current || current.topics.length === 0) return { retry: false };
    try {
      await options.remoteSubscribe(deviceId, current.topics);
      return { retry: false };
    } catch (error) {
      const retry = !options.isPermanentError(error, deviceId);
      options.log.warn(
        `device-link replay subscriptions failed for ${deviceId.slice(0, 8)}, ` +
        `${retry ? 'retrying with backoff' : 'permanent, giving up'}: ${String(error)}`,
      );
      return { retry };
    }
  }, {
    unrefRetryTimers: true,
    retryBaseMs: options.retryBaseMs ?? 3_000,
    retryMaxMs: options.retryMaxMs ?? 30_000,
  });

  return {
    replay(reason, deviceId) {
      const refs = options.snapshotSubscriptions(deviceId);
      if (refs.length === 0) return;
      options.log.debug(
        `device-link replay subscriptions (${reason}): devices=${refs.length} ` +
        `topics=${refs.reduce((sum, ref) => sum + ref.topics.length, 0)}`,
      );
      scheduler.requestMany(refs.map((ref) => ref.deviceId));
    },
    cancel(deviceId) { scheduler.cancel(deviceId); },
    teardown() { scheduler.clear(); },
  };
}
