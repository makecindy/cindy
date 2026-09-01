interface FocusedTopicSubscriptionParams {
  deviceId: string;
  owner: string;
  subscribe(owner: string, deviceId: string, topics: string[]): Promise<void>;
  topic: string;
  unsubscribe(owner: string, deviceId: string, topics: string[]): Promise<void>;
}

interface ReadAfterTopicSubscriptionAckParams<T> extends FocusedTopicSubscriptionParams {
  read(): Promise<T>;
}

let nextFocusedTopicSubscriptionId = 0;

/**
 * Holds a heavy device-link topic only while its screen is focused.
 * If blur happens before subscribe resolves, cleanup releases the local owner
 * immediately and then sends one more unsubscribe after the subscribe
 * acknowledgement so the target cannot retain a stale heavy stream due to
 * unsubscribe-before-subscribe delivery.
 *
 * Each focus interval gets a unique local owner so a slow blur cleanup from a
 * previous focus cannot release a newer focus interval's hold on the same topic.
 */
export function startFocusedTopicSubscription({
  deviceId,
  owner,
  subscribe,
  topic,
  unsubscribe,
}: FocusedTopicSubscriptionParams): () => void {
  const focusOwner = `${owner}:focus:${(nextFocusedTopicSubscriptionId += 1).toString(36)}`;
  const topics = [topic];
  let cleanupRequested = false;
  let subscribed = false;
  let postSubscribeCleanupSent = false;

  const sendCleanup = (afterSubscribe: boolean): void => {
    if (afterSubscribe) postSubscribeCleanupSent = true;
    void unsubscribe(focusOwner, deviceId, topics).catch(() => undefined);
  };

  void subscribe(focusOwner, deviceId, topics)
    .then(() => {
      subscribed = true;
      if (cleanupRequested && !postSubscribeCleanupSent) sendCleanup(true);
    })
    .catch(() => {
      if (cleanupRequested && !postSubscribeCleanupSent) sendCleanup(true);
    });

  return () => {
    if (cleanupRequested) return;
    cleanupRequested = true;
    sendCleanup(subscribed);
  };
}

/**
 * One-shot barrier for authoritative reads: the remote subscription must be acknowledged before
 * the snapshot starts. The temporary owner is always released, including subscribe/read errors.
 */
export async function readAfterTopicSubscriptionAck<T>({
  deviceId,
  owner,
  read,
  subscribe,
  topic,
  unsubscribe,
}: ReadAfterTopicSubscriptionAckParams<T>): Promise<T> {
  const topics = [topic];
  try {
    await subscribe(owner, deviceId, topics);
    return await read();
  } finally {
    await unsubscribe(owner, deviceId, topics).catch(() => undefined);
  }
}
