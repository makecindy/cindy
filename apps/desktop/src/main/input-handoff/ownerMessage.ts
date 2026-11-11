/**
 * Whether a message in the task is the owner writing, the only thing that closes
 * their waiting 代输入 card. A shared-task guest, a plugin, a teammate bot or an
 * App card is not the owner. The queue (at enqueue) and the same-turn steer (at
 * delivery) both ask this, so the two entrances cannot disagree.
 */
export interface MessageSource {
  sharedTaskAuthor?: unknown;
  sourcePlugin?: unknown;
  botTaskCoordination?: unknown;
  /** The guard an App card message carries. */
  appMessageGuard?: unknown;
}

export function isOwnerOwnMessage(source: MessageSource): boolean {
  return !(source.sharedTaskAuthor || source.sourcePlugin || source.botTaskCoordination || source.appMessageGuard);
}
