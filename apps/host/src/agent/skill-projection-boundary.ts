/**
 * Read-only view of the Skill projection owner boundary for this Host profile (release table row 25,
 * step 25a).
 *
 * The boundary module is the desktop's own (`authBoundaryQuarantine.ts`). It reads the profile from
 * `getUserDataDir()`, which the Host pins at startup, and its passive check defaults to "not
 * passive": a Host never joins another process's shared dev profile. Under option A the window
 * commits the owner and the Host only joins it, so nothing here writes or takes the boundary lock.
 * The real decision still happens under the lock in each mutation (shared Skill projection, Codex
 * home preparation), and a stale read here cannot authorize anything.
 */
import {
  isGhostSkillProjectionBoundaryStableForOwner,
  readGhostSkillProjectionBoundaryState,
} from '../../../desktop/src/main/authBoundaryQuarantine.ts';

/**
 * A category only: no owner id (another account's id must not reach the status interface).
 * A state file that exists but cannot be read is `missing-or-invalid`, as the boundary itself
 * treats it (fail closed, logged by the module); `unreadable` means the check itself threw, for
 * example the profile is not configured.
 */
export type SkillProjectionBoundaryStatus =
  | 'stable'
  | 'other-owner'
  | 'pending'
  | 'quarantined'
  | 'missing-or-invalid'
  | 'unreadable';

export function readSkillProjectionBoundaryStatus(ownerId: string): SkillProjectionBoundaryStatus {
  try {
    // State first, then the stability check: the window may commit between the two reads, and a
    // commit that lands in between then reads as `stable` rather than as a stale category.
    const state = readGhostSkillProjectionBoundaryState();
    if (isGhostSkillProjectionBoundaryStableForOwner(ownerId)) return 'stable';
    if (!state) return 'missing-or-invalid';
    // Stable for this owner and still refused: the durable quarantine marker (the Host commits
    // nothing, so its in-process quarantine flag never turns on). Trimmed as the module compares.
    if (state.phase === 'stable') return state.ownerId === ownerId.trim() ? 'quarantined' : 'other-owner';
    return state.phase;
  } catch {
    return 'unreadable';
  }
}

/** The one log call the observer makes; main.ts binds createLogger('host-skill-projection'). */
export interface SkillProjectionBoundaryLog {
  warn(message: string, fields: { boundary: SkillProjectionBoundaryStatus }): void;
}

/**
 * Reads the status for each caller (startup and every authorized /health) and logs a warning when
 * it turns to a non-stable category. The log carries the category only, no owner id or path.
 */
export function createSkillProjectionBoundaryObserver(
  log: SkillProjectionBoundaryLog,
): (ownerId: string) => SkillProjectionBoundaryStatus {
  let lastLogged: SkillProjectionBoundaryStatus | null = null;
  return (ownerId) => {
    const boundary = readSkillProjectionBoundaryStatus(ownerId);
    if (boundary === 'stable') {
      lastLogged = null;
    } else if (boundary !== lastLogged) {
      lastLogged = boundary;
      // Until the window commits this account here, the boundary's mutations refuse to run for it.
      log.warn('skill projection boundary is not stable for this Host owner', { boundary });
    }
    return boundary;
  };
}
