import { DeviceLinkError, parseSharedTaskPeer } from './protocol.js';

/** A shared peer must prove DB health through its own task, never the owner's task list. */
export async function probeSharedTaskHost<T>(peer: string, deps: {
  isCurrent(): boolean;
  get(sharedTaskId: string): Promise<{ sharedTaskId: string; sessionId: string; status: string }>;
  openLink(): Promise<unknown>;
  invoke(channel: string, args: unknown[]): Promise<T>;
}): Promise<T> {
  const parsed = parseSharedTaskPeer(peer);
  const assertCurrent = () => {
    if (!deps.isCurrent()) throw new DeviceLinkError('ACCESS_REVOKED', 'Shared task probe scope changed');
  };
  assertCurrent();
  if (parsed?.role !== 'host') throw new DeviceLinkError('ACCESS_REVOKED', 'Invalid shared task host');
  const detail = await deps.get(parsed.sharedTaskId);
  assertCurrent();
  if (detail.sharedTaskId !== parsed.sharedTaskId || detail.status !== 'active' || !detail.sessionId) {
    throw new DeviceLinkError('ACCESS_REVOKED', 'Shared task unavailable');
  }
  await deps.openLink();
  assertCurrent();
  const result = await deps.invoke('local-db:sessions:get', [detail.sessionId]);
  assertCurrent();
  return result;
}
