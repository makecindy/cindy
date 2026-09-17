import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();
/** Scope uploads for one trusted outbound call; never a global mutable flag. */
export function withSessionMeetingMedia<T>(meetingId: string | undefined, work: () => T): T {
  return meetingId ? scope.run(meetingId, work) : work();
}
export function sessionMeetingMediaId(): string | undefined { return scope.getStore(); }
