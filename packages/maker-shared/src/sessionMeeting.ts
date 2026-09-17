/** Product-neutral Session meeting primitives shared by Desktop and Mobile. */
export type SessionMeetingRole = 'host' | 'guest';
export type SessionMeetingStatus = 'active' | 'closed';

/** Authenticated by the task host, persisted for attribution, never an authorization token. */
export interface SessionMeetingAuthor {
  meetingId: string;
  sessionId: string;
  memberId: string;
  accountId: string;
  displayName: string;
}

/** Tolerant projection for old history; this is attribution, never authority. */
export function sessionMeetingAuthorName(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object' || !('meetingAuthor' in meta)) return undefined;
  const author = meta.meetingAuthor;
  if (!author || typeof author !== 'object' || !('displayName' in author)) return undefined;
  return typeof author.displayName === 'string' ? author.displayName.slice(0, 128) : undefined;
}
