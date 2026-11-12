import type { Topic } from '@cindy/device-link';

const pendingReleases = new WeakMap<object, Map<string, Promise<void>>>();
const pendingAcks = new WeakMap<object, Map<string, Promise<boolean>>>();

/** An ACK from an invalidated subscription cannot complete a still-held owner's
 * request. Re-evaluate ownership and obtain a fresh ACK, without reopening links. */
export async function confirmTrackedSubscription(deps: {
  /** Client identity isolates accounts/connections; generations isolate recovery. */
  share?: { scope: object; deviceId: string };
  isCurrent(): boolean;
  generation(): string;
  missing(): Topic[];
  send(topics: Topic[]): Promise<boolean>;
  acknowledge(topics: Topic[]): void;
}): Promise<void> {
  while (deps.isCurrent()) {
    const generation = deps.generation();
    const topics = deps.missing();
    if (topics.length === 0) return;
    let task: Promise<boolean>;
    if (deps.share) {
      const { scope, deviceId } = deps.share;
      const pending = pendingAcks.get(scope) ?? new Map<string, Promise<boolean>>();
      pendingAcks.set(scope, pending);
      const key = JSON.stringify([deviceId, generation, [...topics].sort()]);
      const existing = pending.get(key);
      if (existing) task = existing;
      else {
        task = deps.send(topics).finally(() => {
          if (pending.get(key) === task) pending.delete(key);
        });
        pending.set(key, task);
      }
    } else task = deps.send(topics);
    const sent = await task;
    if (!deps.isCurrent()) return;
    if (!sent || deps.generation() !== generation) continue;
    deps.acknowledge(topics);
    return;
  }
}

/** Late focus cleanups for one released topic/generation share the wire call.
 * A subsequent acquisition/release has a new generation and cannot join it. */
export async function releaseTrackedSubscription(deps: {
  share: { scope: object; deviceId: string };
  topics: readonly Topic[];
  generation(topic: Topic): string;
  send(topics: Topic[]): Promise<void>;
}): Promise<void> {
  const { scope, deviceId } = deps.share;
  const pending = pendingReleases.get(scope) ?? new Map<string, Promise<void>>();
  pendingReleases.set(scope, pending);
  const waits = new Set<Promise<void>>();
  const missing = new Map<string, Topic>();
  for (const topic of deps.topics) {
    const key = JSON.stringify([deviceId, topic, deps.generation(topic)]);
    const task = pending.get(key);
    if (task) waits.add(task);
    else missing.set(key, topic);
  }
  if (missing.size) {
    const task = Promise.resolve().then(() => deps.send([...missing.values()])).finally(() => {
      for (const key of missing.keys()) if (pending.get(key) === task) pending.delete(key);
    });
    for (const key of missing.keys()) pending.set(key, task);
    waits.add(task);
  }
  await Promise.all(waits);
}

/** Observable projection of the existing ACK table. A release/re-ACK produces a
 * new identity even when the final topic names are identical. */
export class SubscriptionAcknowledgements extends Map<string, Set<Topic>> {
  private revision = 0;
  private revisions = new Map<string, Map<Topic, number>>();
  private invalidations = new Map<string, number>();
  private topicInvalidations = new Map<string, Map<Topic, number>>();
  private clearedAt = 0;
  constructor(private readonly changed: () => void) {
    super();
  }

  identity(deviceId: string, topics: readonly Topic[]): number | null {
    const held = this.get(deviceId);
    return held && topics.every((topic) => held.has(topic))
      ? Math.max(0, ...topics.map(topic => this.revisions.get(deviceId)?.get(topic) ?? 0))
      : null;
  }

  /** Releasing a not-yet-ACKed topic must also fence its pending acquisition. */
  invalidate(deviceId: string, topics?: readonly Topic[]): void {
    const revision = ++this.revision;
    if (!topics) this.invalidations.set(deviceId, revision);
    else {
      const invalidated = this.topicInvalidations.get(deviceId) ?? new Map<Topic, number>();
      for (const topic of topics) invalidated.set(topic, revision);
      this.topicInvalidations.set(deviceId, invalidated);
    }
  }

  generation(deviceId: string, topics: readonly Topic[] = []): number {
    return Math.max(this.invalidations.get(deviceId) ?? this.clearedAt,
      ...topics.map(topic => this.topicInvalidations.get(deviceId)?.get(topic) ?? 0));
  }

  /** Fence the released topics even when their first ACK has not arrived. */
  release(deviceId: string, topics: readonly Topic[]): void {
    if (!topics.length) return;
    this.invalidate(deviceId, topics);
    const held = this.get(deviceId);
    if (held) this.set(deviceId, new Set([...held].filter(topic => !topics.includes(topic))));
  }

  override set(deviceId: string, topics: Set<Topic>): this {
    const previous = this.get(deviceId);
    if (previous?.size === topics.size && [...topics].every((topic) => previous.has(topic)))
      return this;
    super.set(deviceId, topics);
    const revision = ++this.revision;
    const previousRevisions = this.revisions.get(deviceId);
    // An unrelated topic's ACK/release must not invalidate still-held topics.
    this.revisions.set(deviceId, new Map([...topics].map(topic => [topic,
      previous?.has(topic) ? previousRevisions?.get(topic) ?? revision : revision,
    ])));
    if (previous && [...previous].some((topic) => !topics.has(topic))) {
      this.invalidate(deviceId, [...previous].filter(topic => !topics.has(topic)));
    }
    this.changed();
    return this;
  }

  override delete(deviceId: string): boolean {
    const deleted = super.delete(deviceId);
    this.revisions.delete(deviceId);
    this.topicInvalidations.delete(deviceId);
    this.invalidations.set(deviceId, ++this.revision);
    if (deleted) this.changed();
    return deleted;
  }

  override clear(): void {
    const hadTopics = this.size > 0;
    super.clear();
    this.revisions.clear();
    this.invalidations.clear();
    this.topicInvalidations.clear();
    this.clearedAt = ++this.revision;
    if (hadTopics) this.changed();
  }
}
