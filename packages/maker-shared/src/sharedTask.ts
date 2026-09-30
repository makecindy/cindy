/** Product-neutral Session sharedTask primitives shared by Desktop and Mobile. */
export type SharedTaskRole = 'host' | 'guest';
export type SharedTaskStatus = 'active' | 'closed';

/** Authenticated by the task host, persisted for attribution, never an authorization token. */
export interface SharedTaskAuthor {
  sharedTaskId: string;
  sessionId: string;
  memberId: string;
  accountId: string;
  displayName: string;
}

/** Tolerant projection for old history; this is attribution, never authority. */
export function sharedTaskAuthorName(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object' || !('sharedTaskAuthor' in meta)) return undefined;
  const author = meta.sharedTaskAuthor;
  if (!author || typeof author !== 'object' || !('displayName' in author)) return undefined;
  return typeof author.displayName === 'string' ? author.displayName.slice(0, 128) : undefined;
}
