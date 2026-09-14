import type { PermissionMode, Session } from '@cindy/maker-core';

function permissionMode(mode: unknown): PermissionMode | null {
  if (
    mode === 'ask' ||
    mode === 'default' ||
    mode === 'acceptEdits' ||
    mode === 'plan' ||
    mode === 'auto' ||
    mode === 'bypassPermissions'
  )
    return mode;
  return null;
}

/** Never fall back from an unstable live session or a missing/incomplete durable snapshot. */
export function routinePermissionSnapshot(
  live: Pick<Session, 'stablePermissionModeState'> | undefined,
  stored: { permissionMode: unknown; planModeEnabled: unknown } | null,
): { permissionMode: PermissionMode; planMode: boolean } | null {
  if (!stored || typeof stored.planModeEnabled !== 'boolean') return null;
  const mode = permissionMode(stored.permissionMode);
  if (!mode) return null;
  if (live) {
    const stable = live.stablePermissionModeState;
    // A persistence/runtime mismatch may be a partially applied user change; wait for it to settle.
    if (!stable || stable.mode !== mode) return null;
  }
  return { permissionMode: mode, planMode: stored.planModeEnabled };
}
