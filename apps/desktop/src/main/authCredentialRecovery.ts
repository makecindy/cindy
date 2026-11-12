/** Electron's macOS OSCrypt caches the first keychain failure for the process.
 * Only a new process can retry that read. Consume observed auth failures; never
 * probe safeStorage here (the probe itself can request keychain access).
 */
export const AUTH_CREDENTIAL_RECOVERY_ARG = '--cindy-auth-recovery-attempted';

export interface AuthCredentialRecoveryDeps {
  enabled: boolean;
  argv: readonly string[];
  needsRecovery: () => boolean;
  readScreenState: () => 'active' | 'idle' | 'locked' | 'unknown';
  isQuitting: () => boolean;
  isBusy: () => Promise<boolean>;
  relaunch: (args: string[]) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  onEvent: (
    event:
      | 'waiting-for-unlock'
      | 'waiting-for-idle'
      | 'relaunching'
      | 'attempt-exhausted'
      | 'relaunch-failed',
  ) => void;
}

export function createAuthCredentialRecovery(deps: AuthCredentialRecoveryDeps) {
  let disposed = false;
  let attempted = deps.argv.includes(AUTH_CREDENTIAL_RECOVERY_ARG);
  let exhaustionReported = false;
  let checking = false;
  let timer: unknown | null = null;
  // Events invalidate an async busy result even if the screen has unlocked again.
  let screenEpoch = 0;
  let explicitlyLocked = false;
  let lastEvent: Parameters<AuthCredentialRecoveryDeps['onEvent']>[0] | null = null;

  const report: AuthCredentialRecoveryDeps['onEvent'] = (event) => {
    if (lastEvent === event) return;
    lastEvent = event;
    deps.onEvent(event);
  };
  const cancelTimer = () => {
    if (timer !== null) deps.cancel(timer);
    timer = null;
  };
  const eligible = () => !disposed && deps.enabled && !deps.isQuitting() && deps.needsRecovery();
  const screenUsable = () => {
    try {
      const state = deps.readScreenState();
      if (state !== 'active' && state !== 'idle') return false;
      explicitlyLocked = false;
      return true;
    } catch {
      return false;
    }
  };
  const request = (delayMs = 3_000): void => {
    if (!eligible() || timer !== null || checking) return;
    if (attempted) {
      if (!exhaustionReported) {
        exhaustionReported = true;
        report('attempt-exhausted');
      }
      return;
    }
    timer = deps.schedule(() => {
      timer = null;
      void check();
    }, delayMs);
  };
  const check = async (): Promise<void> => {
    if (!eligible() || attempted || checking) return;
    if (!screenUsable()) {
      report('waiting-for-unlock');
      // Also covers a missed unlock event or a temporarily unknown system state.
      request(30_000);
      return;
    }
    checking = true;
    const epoch = screenEpoch;
    let busy = true;
    try {
      busy = await deps.isBusy();
    } catch {
      // A failed activity query must never interrupt work.
    } finally {
      checking = false;
    }
    if (!eligible() || attempted) return;
    if (screenEpoch !== epoch || !screenUsable()) {
      request(explicitlyLocked ? 30_000 : 3_000);
      return;
    }
    if (busy) {
      report('waiting-for-idle');
      request(30_000);
      return;
    }
    attempted = true;
    exhaustionReported = true;
    report('relaunching');
    try {
      // Preserve profile/passive flags. The successor inherits the one-attempt
      // budget; a later ordinary user launch starts a fresh recovery episode.
      deps.relaunch([...deps.argv, AUTH_CREDENTIAL_RECOVERY_ARG]);
    } catch {
      report('relaunch-failed');
    }
  };
  return {
    request: () => request(),
    onScreenLock: () => {
      explicitlyLocked = true;
      screenEpoch += 1;
      cancelTimer();
      request(30_000);
    },
    onScreenUnlock: () => {
      explicitlyLocked = false;
      screenEpoch += 1;
      cancelTimer();
      request();
    },
    dispose: () => {
      disposed = true;
      cancelTimer();
    },
  };
}
