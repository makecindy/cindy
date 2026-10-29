import { describePermissionAction } from '@cindy/maker-shared/interaction';

export type SeenUnit = 's' | 'm' | 'h';

/**
 * Age for the "Seen … ago" label. It is measured from when THIS window first saw the request
 * (the store carries no request timestamp), so it restarts when the window reloads and may be
 * shorter than the real wait. Never present it as "waiting since" or "requested at".
 */
export function formatSeenAge(elapsedMs: number): { unit: SeenUnit; count: number } {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return { unit: 's', count: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'm', count: minutes };
  return { unit: 'h', count: Math.floor(minutes / 60) };
}

export const SEEN_KEYS: Record<SeenUnit, string> = {
  s: 'approvalsInbox.seenSeconds',
  m: 'approvalsInbox.seenMinutes',
  h: 'approvalsInbox.seenHours',
};

export type ApprovalKind = 'command' | 'edit' | 'folder' | 'other';

/** Coarse request class for the queue; the exact operation is only ever shown by PermissionPrompt. */
export function requestKind(toolName: string, input: Record<string, unknown>): ApprovalKind {
  const action = describePermissionAction(toolName, input);
  if (action.kind === 'command') return 'command';
  if (action.kind === 'file-write') return 'edit';
  // A plain single-file Read is not folder access; Glob/Grep/LS/Find are.
  if (action.kind === 'file-read') return toolName.toLowerCase() === 'read' ? 'other' : 'folder';
  return 'other';
}

/** Last path segment for either separator; null for an empty path. */
export function pathBaseName(path: string | null | undefined): string | null {
  const trimmed = (path ?? '').replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  return trimmed.split(/[\\/]/).pop() || null;
}
