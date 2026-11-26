/**
 * The session permission modes and their teammate Profile values, moved verbatim out of
 * sessionPermissionPersistence.ts so the Node Host can validate a mode without loading that file's
 * Bot lane sync (which reaches the desktop's Maker host). sessionPermissionPersistence.ts re-exports them.
 */
const SESSION_PERMISSION_MODES = new Set([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

export function isSessionPermissionMode(mode: string): boolean {
  return SESSION_PERMISSION_MODES.has(mode);
}

/** Profile stores only the three teammate permission values. Other session modes stay on the session row. */
export function profilePermissionForSessionMode(mode: string): 'ask' | 'auto' | 'trusted' | null {
  if (mode === 'bypassPermissions') return 'trusted';
  if (mode === 'auto') return 'auto';
  if (mode === 'ask') return 'ask';
  return null;
}
