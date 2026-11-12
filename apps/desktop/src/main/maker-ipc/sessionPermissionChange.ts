/**
 * Orders complete user/plugin permission commits, including persistence and
 * rollback. This is separate from the send/restart fence: a runtime permission
 * change can wait for a running turn's policy lease to finish. That turn must
 * remain free to continue and restore its temporary policy.
 */
const permissionChanges = new Map<string, Promise<void>>();

export function withSessionPermissionChange<T>(
  sessionId: string,
  change: () => Promise<T>,
): Promise<T> {
  const previous = permissionChanges.get(sessionId) ?? Promise.resolve();
  const operation = previous.then(change);
  const settled = operation.then(() => undefined, () => undefined);
  permissionChanges.set(sessionId, settled);
  return operation.finally(() => {
    if (permissionChanges.get(sessionId) === settled) permissionChanges.delete(sessionId);
  });
}
