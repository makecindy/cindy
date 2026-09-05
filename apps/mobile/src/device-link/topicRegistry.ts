import type { Topic } from '@cindy/device-link';

export interface RehydratePlan {
  deviceId: string;
  openLink: boolean;
  topics: Topic[];
}

export type RemoteTopicAckMap = Map<string, Set<Topic>>;

/**
 * Tracks controller intent that must survive mobile foreground/background WS
 * churn. It is not a data cache; remote data remains host-authoritative.
 */
export class DeviceLinkTopicRegistry {
  private readonly openLinks = new Set<string>();
  // Per-device topic *ownership*: deviceId → (topic → set of owner ids holding it).
  // Each mounted consumer (a screen, keyed by a stable ownerId) declares the topics it
  // needs; a topic stays alive while ANY owner holds it. This models the codebase's
  // idempotent "ensure-subscribed" usage — the same screen may (re)subscribe many times
  // across resync/retry, but adding an owner is idempotent (a Set), so it never
  // over-counts. A topic is only released (server unsubscribe) when its LAST owner drops
  // it, so one screen unmounting can't tear down a topic another screen still needs, and
  // reconnect rehydration keeps every still-owned topic.
  private readonly topicOwners = new Map<string, Map<Topic, Set<string>>>();

  trackOpenLink(deviceId: string): void {
    if (deviceId) this.openLinks.add(deviceId);
  }

  untrackOpenLink(deviceId: string): void {
    this.openLinks.delete(deviceId);
  }

  /** Register `owner` as a holder of each topic for this device. Idempotent per (owner, topic). */
  trackSubscribe(owner: string, deviceId: string, topics: readonly string[]): void {
    const clean = normalizeDeviceLinkTopics(topics);
    if (!owner || !deviceId || clean.length === 0) return;
    const byTopic = this.topicOwners.get(deviceId) ?? new Map<Topic, Set<string>>();
    for (const topic of clean) {
      const owners = byTopic.get(topic) ?? new Set<string>();
      owners.add(owner);
      byTopic.set(topic, owners);
    }
    this.topicOwners.set(deviceId, byTopic);
  }

  /**
   * Release `owner`'s hold on the given topics (or, when `topics` is omitted, every topic
   * it holds on this device — convenient for unmount cleanup). Returns only the topics
   * whose last owner just released them; callers should send the server unsubscribe for
   * exactly these. Topics still held by another owner are retained.
   */
  untrackSubscribe(owner: string, deviceId: string, topics?: readonly string[]): Topic[] {
    const byTopic = this.topicOwners.get(deviceId);
    if (!byTopic || !owner) return [];
    const targets = topics ? normalizeDeviceLinkTopics(topics) : [...byTopic.keys()];
    const released: Topic[] = [];
    for (const topic of targets) {
      const owners = byTopic.get(topic);
      if (!owners || !owners.delete(owner)) continue;
      if (owners.size === 0) {
        byTopic.delete(topic);
        released.push(topic);
      }
    }
    if (byTopic.size === 0) this.topicOwners.delete(deviceId);
    return released;
  }

  snapshot(): RehydratePlan[] {
    return this.deviceIds().map((deviceId) => this.snapshotDevice(deviceId)!);
  }

  /** Current recovery intent for one peer; null means this peer has no held work. */
  snapshotDevice(deviceId: string): RehydratePlan | null {
    const openLink = this.openLinks.has(deviceId);
    const topics = [...(this.topicOwners.get(deviceId)?.keys() ?? [])].sort();
    if (!openLink && topics.length === 0) return null;
    return { deviceId, openLink, topics };
  }

  /**
   * Stable peer order used to seed the fair recovery scheduler. Peers with visible
   * topic work go first; historical open-link-only intent must not delay the machine
   * whose Home/session content is currently on screen.
   */
  deviceIds(): string[] {
    return [...new Set<string>([...this.openLinks, ...this.topicOwners.keys()])].sort((a, b) => {
      const aHasTopics = (this.topicOwners.get(a)?.size ?? 0) > 0;
      const bHasTopics = (this.topicOwners.get(b)?.size ?? 0) > 0;
      if (aHasTopics !== bHasTopics) return aHasTopics ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  hasTopic(deviceId: string, topic: string): boolean {
    const clean = normalizeDeviceLinkTopics([topic]);
    if (clean.length === 0) return false;
    return this.topicOwners.get(deviceId)?.has(clean[0]) === true;
  }

  clear(): void {
    this.openLinks.clear();
    this.topicOwners.clear();
  }
}

export function normalizeDeviceLinkTopics(topics: readonly string[]): Topic[] {
  return topics.filter((topic): topic is Topic =>
    topic === 'sessions'
    || topic.startsWith('session:')
    // 文件浏览的目录变更订阅(被控端 watch 引擎由该 topic 的订阅/释放驱动)。
    || topic.startsWith('fs-watch:'));
}

export function topicsMissingRemoteAck(
  acked: RemoteTopicAckMap,
  deviceId: string,
  topics: readonly Topic[],
): Topic[] {
  const current = acked.get(deviceId);
  if (!current) return [...new Set(topics)];
  return [...new Set(topics)].filter((topic) => !current.has(topic));
}

export function markRemoteTopicsSubscribed(
  acked: RemoteTopicAckMap,
  deviceId: string,
  topics: readonly Topic[],
): void {
  if (!deviceId || topics.length === 0) return;
  const current = new Set(acked.get(deviceId));
  for (const topic of topics) current.add(topic);
  acked.set(deviceId, current);
}

export function markHeldRemoteTopicsSubscribed(
  acked: RemoteTopicAckMap,
  registry: DeviceLinkTopicRegistry,
  deviceId: string,
  topics: readonly Topic[],
): Topic[] {
  const stillHeld = topics.filter((topic) => registry.hasTopic(deviceId, topic));
  markRemoteTopicsSubscribed(acked, deviceId, stillHeld);
  return stillHeld;
}

export function markRemoteTopicsUnsubscribed(
  acked: RemoteTopicAckMap,
  deviceId: string,
  topics: readonly Topic[],
): void {
  if (!acked.has(deviceId)) return;
  const current = new Set(acked.get(deviceId));
  for (const topic of topics) current.delete(topic);
  if (current.size === 0) acked.delete(deviceId);
  else acked.set(deviceId, current);
}

/**
 * Combines durable screen/topic intent with a transient transport-forced reopen.
 * ACK reset can happen after the final topic owner has already released, while a reliable
 * request is still pending in the client. In that case the synthetic open-only plan is the
 * only way to thaw the peer without rebuilding the shared WSS.
 */
export function resolvePeerRecoveryPlan(
  deviceId: string,
  durablePlan: RehydratePlan | null,
  forceOpen: boolean,
): RehydratePlan | null {
  if (!durablePlan) {
    return forceOpen ? { deviceId, openLink: true, topics: [] } : null;
  }
  if (!forceOpen || durablePlan.openLink) return durablePlan;
  return { ...durablePlan, openLink: true };
}
