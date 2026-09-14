import path from 'node:path';

export function isSafeTurnChangeSetSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value !== '.' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0') &&
    !value.includes(':')
  );
}

export function turnChangeSetStorageRoot(userDataDir: string): string {
  return path.join(userDataDir, 'turn-change-sets');
}

export function turnChangeSetSessionDirectory(userDataDir: string, sessionId: string): string {
  if (!isSafeTurnChangeSetSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
  return path.join(turnChangeSetStorageRoot(userDataDir), sessionId);
}
