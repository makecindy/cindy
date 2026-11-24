export type AwayGuardFailure = 'permission' | 'unavailable';

/** Settings → General → While away. Local app renderer only. */
export interface AwayGuardState {
  /** The local platform has a supported privacy screen backend. */
  available: boolean;
  enabled: boolean;
  /** Seconds of absence before the cover; null follows the system display-sleep time. */
  delaySeconds: AwayGuardDelaySeconds | null;
  /** Accessibility access of the input helper that turns local input into the lock. */
  permission: 'granted' | 'missing' | 'unknown';
  /** Local settings only. Distinguishes installed copies with the same display name. */
  permissionAppPath?: string;
  backgroundFailure?: AwayGuardFailure;
}

export const AWAY_GUARD_DELAY_OPTIONS = [30, 60, 120, 300] as const;
export type AwayGuardDelaySeconds = (typeof AWAY_GUARD_DELAY_OPTIONS)[number];
export function isAwayGuardDelaySeconds(value: unknown): value is AwayGuardDelaySeconds {
  return (AWAY_GUARD_DELAY_OPTIONS as readonly unknown[]).includes(value);
}

export const AWAY_GUARD_GET_STATE_CHANNEL = 'away-guard:get-state';
export const AWAY_GUARD_SET_DELAY_CHANNEL = 'away-guard:set-delay';
export const AWAY_GUARD_SET_ENABLED_CHANNEL = 'away-guard:set-enabled';
/** "Try it": cover the displays shortly so the owner can check the lock and unlock path. */
export const AWAY_GUARD_PREVIEW_CHANNEL = 'away-guard:preview';
/** Lets the hand that clicked "Try it" leave the mouse before physical input means "lock". */
export const AWAY_GUARD_PREVIEW_DELAY_MS = 3_000;

export type AwayGuardPreviewResult = { ok: true } | { ok: false; reason: AwayGuardFailure | 'checkFailed' };

/** macOS 14 使用 Darwin 23；preload 与 main 共用内核版本，避免两端可用性漂移。 */
export function isAwayGuardSupportedPlatform(platform: string, osRelease: string): boolean {
  return platform === 'darwin' && Number(osRelease.split('.')[0]) >= 23;
}
