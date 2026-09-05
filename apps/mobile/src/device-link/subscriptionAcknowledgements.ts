import type { Topic } from '@cindy/device-link';

/** An ACK from an invalidated subscription cannot complete a still-held owner's
 * request. Re-evaluate ownership and obtain a fresh ACK, without reopening links. */
export async function confirmTrackedSubscription(deps: {
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
    const sent = await deps.send(topics);
    if (!deps.isCurrent()) return;
    if (!sent || deps.generation() !== generation) continue;
    deps.acknowledge(topics);
    return;
  }
}

/** Observable projection of the existing ACK table. A release/re-ACK produces a
 * new identity even when the final topic names are identical. */
export class SubscriptionAcknowledgements extends Map<string, Set<Topic>> {
  private revision = 0;
  private revisions = new Map<string, number>();
  private invalidations = new Map<string, number>();
  private clearedAt = 0;
  constructor(private readonly changed: () => void) {
    super();
  }

  identity(deviceId: string, topics: readonly Topic[]): number | null {
    const held = this.get(deviceId);
    return held && topics.every((topic) => held.has(topic))
      ? (this.revisions.get(deviceId) ?? null)
      : null;
  }

  generation(deviceId: string): number {
    return this.invalidations.get(deviceId) ?? this.clearedAt;
  }

  override set(deviceId: string, topics: Set<Topic>): this {
    const previous = this.get(deviceId);
    if (previous?.size === topics.size && [...topics].every((topic) => previous.has(topic)))
      return this;
    super.set(deviceId, topics);
    this.revisions.set(deviceId, ++this.revision);
    if (previous && [...previous].some((topic) => !topics.has(topic))) {
      this.invalidations.set(deviceId, this.revision);
    }
    this.changed();
    return this;
  }

  override delete(deviceId: string): boolean {
    const deleted = super.delete(deviceId);
    this.revisions.delete(deviceId);
    this.invalidations.set(deviceId, ++this.revision);
    if (deleted) this.changed();
    return deleted;
  }

  override clear(): void {
    const hadTopics = this.size > 0;
    super.clear();
    this.revisions.clear();
    this.invalidations.clear();
    this.clearedAt = ++this.revision;
    if (hadTopics) this.changed();
  }
}
