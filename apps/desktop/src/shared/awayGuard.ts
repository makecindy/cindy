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
/** "Try it": cover the displays shortly so the owner can check the lock and unlock path. */
export const AWAY_GUARD_PREVIEW_CHANNEL = 'away-guard:preview';
/** Lets the hand that clicked "Try it" leave the mouse before physical input means "lock". */
export const AWAY_GUARD_PREVIEW_DELAY_MS = 3_000;

export type AwayGuardPreviewResult = { ok: true } | { ok: false; reason: 'permission' | 'unavailable' };
