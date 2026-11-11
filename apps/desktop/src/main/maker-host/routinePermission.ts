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
  live: Partial<Pick<Session, 'stablePermissionModeState' | 'stablePlanModeState'>> | undefined,
  stored: { permissionMode: unknown; planModeEnabled: unknown } | null,
): { permissionMode: PermissionMode; planMode: boolean } | null {
  if (!stored || typeof stored.planModeEnabled !== 'boolean') return null;
  const mode = permissionMode(stored.permissionMode);
  if (!mode) return null;
  if (live) {
    const stable = live.stablePermissionModeState;
    // A persistence/runtime mismatch may be a partially applied user change; wait for it to settle.
    if (!stable || stable.mode !== mode) return null;
    const plan = live.stablePlanModeState;
    if (!plan || plan.enabled !== stored.planModeEnabled) return null;
  }
  return { permissionMode: mode, planMode: stored.planModeEnabled };
}

export interface SettledRoutinePermissionMismatch {
  saved: { permissionMode: PermissionMode; planMode: boolean };
  running: { permissionMode: PermissionMode; planMode: boolean };
}

/**
 * Both sides are readable and stable, yet they disagree. Unlike an in-flight switch this
 * does not settle on its own; callers may surface it once it persists across attempts.
 */
export function settledRoutinePermissionMismatch(
  live: Partial<Pick<Session, 'stablePermissionModeState' | 'stablePlanModeState'>>,
  stored: { permissionMode: unknown; planModeEnabled: unknown } | null,
): SettledRoutinePermissionMismatch | null {
  const saved = routinePermissionSnapshot(undefined, stored);
  const runningMode = permissionMode(live.stablePermissionModeState?.mode);
  const runningPlan = live.stablePlanModeState?.enabled;
  if (!saved || !runningMode || typeof runningPlan !== 'boolean') return null;
  if (runningMode === saved.permissionMode && runningPlan === saved.planMode) return null;
  return { saved, running: { permissionMode: runningMode, planMode: runningPlan } };
}
