import { parseClaudeSdkRateLimitInfo } from '@cindy/remote-agent/shared/claudeSubscriptionUsage';

type UsageSnapshot = NonNullable<ReturnType<typeof parseClaudeSdkRateLimitInfo>>;

/** Native CLI events augment the same persisted subscription snapshot on both
 * hosts. A late event after disconnect must never recreate a cleared snapshot. */
export function createClaudeUsageEventRecorder(host: {
  readConnectedAccount(): { fingerprint?: string | null; subscriptionType?: string } | null;
  recordSnapshot(snapshot: UsageSnapshot): Promise<void>;
}) {
  return async (info: unknown): Promise<void> => {
    const account = host.readConnectedAccount();
    if (!account) return;
    const snapshot = parseClaudeSdkRateLimitInfo(info, Date.now());
    if (!snapshot) return;
    await host.recordSnapshot({
      ...snapshot,
      ...(account.fingerprint ? { accountFingerprint: account.fingerprint } : {}),
      ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
    });
  };
}
