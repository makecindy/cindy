/**
 * Why the Cindy Host serving this window did not start (client mode). The Host projects it in its auth
 * state as `hostUnavailable: { reason }` only when its start failed or was refused; an ordinary signed-out
 * state (no session, a session the server rejected or that is gone, a personal account of another region)
 * carries none. Only the code crosses the process boundary, never the Host's error text.
 *
 * The Host (apps/host) imports these codes from here; the desktop never imports the Host.
 */
export const HOST_START_FAILURE_REASONS = [
  /** A Cindy desktop app running on its own uses this data (coexistence plan A). */
  'HOST_PROFILE_IN_USE_BY_DESKTOP',
  /** The saved session's account is not the account of this data. */
  'HOST_ACCOUNT_MISMATCH',
  /** Another Host or Cindy process holds this data's database. */
  'HOST_DATABASE_LOCKED',
  /** The account's database cannot be opened or migrated. */
  'HOST_DATABASE_UNAVAILABLE',
  /** The sign-in service could not be reached while the Host started. */
  'HOST_SIGN_IN_SERVICE_UNREACHABLE',
  /** Anything else. */
  'HOST_START_FAILED',
] as const;

export type HostStartFailureReason = (typeof HOST_START_FAILURE_REASONS)[number];

export interface HostUnavailable {
  reason: HostStartFailureReason;
}

/**
 * The fixed code with which the window refuses its own sign-in and "skip sign-in" while the Host it serves
 * did not start: signing in locally would write a session, the saved accounts and the owner beside a Host
 * that stays down (the release table's testing-period limit).
 */
export const HOST_NOT_STARTED = 'HOST_NOT_STARTED';

/** The reason in a Host auth state, or null. A code this build does not know reads as HOST_START_FAILED. */
export function readHostUnavailableReason(state: { hostUnavailable?: unknown } | null | undefined): HostStartFailureReason | null {
  const value = state?.hostUnavailable;
  if (!value || typeof value !== 'object') return null;
  const reason = (value as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || !reason) return null;
  return (HOST_START_FAILURE_REASONS as readonly string[]).includes(reason)
    ? reason as HostStartFailureReason
    : 'HOST_START_FAILED';
}

/**
 * The i18n keys that explain a reason: what happened, then what to do. The in-use reason reuses the
 * message the coexistence refusal already shows (shared/ipcError.ts hostProfileInUseI18nKey), which says
 * both in one sentence pair.
 */
export function hostStartFailureMessageKeys(reason: HostStartFailureReason): { body: string; action: string | null } {
  if (reason === 'HOST_PROFILE_IN_USE_BY_DESKTOP') {
    return { body: 'logic.errors.hostProfileInUseByDesktopAtStart', action: null };
  }
  return { body: `login.hostUnavailable.reasons.${reason}.body`, action: `login.hostUnavailable.reasons.${reason}.action` };
}
