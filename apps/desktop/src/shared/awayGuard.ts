/** Settings → App behavior → Keep working while away (macOS). Local app renderer only. */
export interface AwayGuardState {
  /** macOS 14+ only; other platforms hide the setting. */
  available: boolean;
  enabled: boolean;
  /** Accessibility access of the input helper that turns local input into the lock. */
  permission: 'granted' | 'missing' | 'unknown';
}

export const AWAY_GUARD_GET_STATE_CHANNEL = 'away-guard:get-state';
export const AWAY_GUARD_SET_ENABLED_CHANNEL = 'away-guard:set-enabled';
