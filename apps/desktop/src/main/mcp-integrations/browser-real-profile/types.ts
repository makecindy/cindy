/**
 * Real-profile browsing: copy the user's Chromium-family login databases into a
 * Cindy-managed snapshot directory, then launch the same browser binary against
 * that copy. This is consent-gated convenience, not an isolation boundary.
 */

export type ChromiumKind = 'chrome' | 'edge' | 'brave' | 'chromium';

export const CHROMIUM_KINDS = ['chrome', 'edge', 'brave', 'chromium'] as const;

export type RealProfileErrorCode =
  | 'NO_CHROMIUM'
  | 'PROFILE_LOCKED'
  | 'NO_AUTH_DB'
  | 'HEADLESS_FORBIDDEN'
  | 'COPY_FAILED'
  | 'STOP_FAILED'
  | 'REAL_PROFILE_READ_DENIED'
  | 'APP_BOUND_ENCRYPTION_UNSUPPORTED';

export class RealProfileError extends Error {
  readonly code: RealProfileErrorCode;

  constructor(code: RealProfileErrorCode, message: string) {
    super(message);
    this.name = 'RealProfileError';
    this.code = code;
  }
}

export function isRealProfileError(err: unknown): err is RealProfileError {
  return err instanceof RealProfileError;
}

export interface InstalledChromium {
  kind: ChromiumKind;
  executablePath: string;
  userDataDir: string;
}

export interface SnapshotResult {
  destDir: string;
  sourceKind: ChromiumKind;
  sourceProfile: string;
  filesCopied: string[];
}

export interface RealProfileStatusHint {
  enabled: boolean;
  applied: boolean;
  source: ChromiumKind | null;
}

export type DefaultBrowserKind = ChromiumKind | 'other' | null;
