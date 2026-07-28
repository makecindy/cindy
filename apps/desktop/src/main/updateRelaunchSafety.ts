/** Marker passed only to a macOS app instance launched by the update script. */
export const MACOS_UPDATE_RELAUNCH_ARG = '--xdt-update-relaunch';

export type UpdateSystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

export function isMacOSUpdateRelaunch(argv: readonly string[]): boolean {
  return argv.includes(MACOS_UPDATE_RELAUNCH_ARG);
}

export interface UpdateRelaunchBusyProbeDeps {
  readSynchronousBusy: () => boolean;
  readScheduleBusy: () => Promise<boolean>;
}

export interface UpdateRelaunchScheduleStorage {
  hasRunningRuns: () => Promise<boolean>;
}

export interface UpdateRelaunchBusyTransition {
  nextBusy: boolean;
  shouldNotify: boolean;
}

/**
 * Collapse controller-list churn into the only edge the update policy needs.
 * Busy polls refresh the quiet-period timestamp separately; this notification
 * only wakes the policy when remote activity starts or fully stops.
 */
export function decideUpdateRelaunchBusyTransition(
  previousBusy: boolean,
  nextBusy: boolean,
): UpdateRelaunchBusyTransition {
  return {
    nextBusy,
    shouldNotify: previousBusy !== nextBusy,
  };
}

/**
 * Scheduler absence is an expected cold-start state, not a busy-query failure.
 * Once storage is initialized, deliberately propagate query failures so the
 * outer unattended-update guard continues to fail closed.
 */
export async function readUpdateRelaunchScheduleBusy(
  storage: UpdateRelaunchScheduleStorage | null,
): Promise<boolean> {
  if (!storage) return false;
  return storage.hasRunningRuns();
}

/**
 * Fail closed on schedule-storage errors and re-sample synchronous activity
 * after the async query. The second read closes the practical event-loop race
 * where a remote viewer or agent turn appears while SQLite is being queried.
 */
export async function hasUpdateRelaunchBusyActivity(
  deps: UpdateRelaunchBusyProbeDeps,
): Promise<boolean> {
  if (deps.readSynchronousBusy()) return true;
  try {
    if (await deps.readScheduleBusy()) return true;
  } catch {
    return true;
  }
  return deps.readSynchronousBusy();
}

export interface UpdatePresentationRecoveryInput {
  pending: boolean;
  screenLocked: boolean;
  windowExists: boolean;
  windowFocused: boolean;
}

export interface UpdatePresentationRecoveryDecision {
  nextPending: boolean;
  focusOnce: boolean;
}

/**
 * Presentation recovery is deliberately independent from update health.
 * Locked or occluded windows can have a healthy main process and renderer;
 * this state machine grants only one bounded recovery sequence.
 */
export function decideUpdatePresentationRecovery(
  input: UpdatePresentationRecoveryInput,
): UpdatePresentationRecoveryDecision {
  if (!input.pending) return { nextPending: false, focusOnce: false };
  if (!input.windowExists) return { nextPending: false, focusOnce: false };
  if (input.windowFocused) return { nextPending: false, focusOnce: false };
  if (input.screenLocked) return { nextPending: true, focusOnce: false };
  return { nextPending: true, focusOnce: true };
}

export interface UpdatePresentationWindowState {
  exists: boolean;
  focused: boolean;
}

export type UpdatePresentationRecoveryEvent =
  | 'deferred-locked'
  | 'focus-window'
  | 'paused-unknown'
  | 'abandoned-unfocused';

export interface UpdatePresentationRecoveryControllerDeps {
  readScreenState: () => UpdateSystemIdleState;
  readWindowState: () => UpdatePresentationWindowState;
  focusWindow: () => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  onEvent?: (event: UpdatePresentationRecoveryEvent) => void;
  settleDelayMs?: number;
  maxFocusAttempts?: number;
}

export interface UpdatePresentationRecoveryController {
  arm: () => void;
  onWindowReady: () => void;
  onWindowFocused: () => void;
  onScreenLock: () => void;
  onScreenUnlock: () => void;
  dispose: () => void;
}

/**
 * Build the one-shot presentation controller used only by update-launched
 * macOS candidates. The controller never contributes to update health: it
 * merely delays a bounded focus sequence until the lock screen has gone away.
 */
export function createUpdatePresentationRecoveryController(
  deps: UpdatePresentationRecoveryControllerDeps,
): UpdatePresentationRecoveryController {
  const settleDelayMs = deps.settleDelayMs ?? 750;
  const maxFocusAttempts = deps.maxFocusAttempts ?? 3;
  let pending = false;
  let windowReady = false;
  let windowFocusObserved = false;
  let screenState: UpdateSystemIdleState = 'unknown';
  let consecutiveUnknownReads = 0;
  let focusAttempts = 0;
  let scheduledHandle: unknown | null = null;

  const cancelScheduled = (): void => {
    if (scheduledHandle === null) return;
    deps.cancel(scheduledHandle);
    scheduledHandle = null;
  };

  const refreshScreenState = (): UpdateSystemIdleState => {
    const observed = deps.readScreenState();
    // lock-screen / unlock-screen events are authoritative. A transient
    // `unknown` probe must not erase the last explicit event; otherwise the
    // recovery can consume itself while loginwindow is still in transition.
    if (observed !== 'unknown' || screenState === 'unknown') screenState = observed;
    return screenState;
  };

  const settle = (): void => {
    scheduledHandle = null;
    refreshScreenState();
    const windowState = deps.readWindowState();
    if (windowState.focused || windowFocusObserved) {
      pending = false;
      return;
    }
    if (screenState === 'unknown') {
      consecutiveUnknownReads += 1;
      if (consecutiveUnknownReads >= 2) {
        // Stop polling, but keep the one-shot pending for a later explicit
        // unlock/focus event. This avoids both infinite retries and permanent
        // loss of recovery when the platform temporarily reports `unknown`.
        deps.onEvent?.('paused-unknown');
        return;
      }
      scheduledHandle = deps.schedule(settle, settleDelayMs);
      return;
    }
    consecutiveUnknownReads = 0;
    const decision = decideUpdatePresentationRecovery({
      pending,
      screenLocked: screenState === 'locked',
      windowExists: windowState.exists,
      windowFocused: windowState.focused,
    });
    pending = decision.nextPending;
    if (!decision.focusOnce) {
      if (decision.nextPending) deps.onEvent?.('deferred-locked');
      return;
    }

    // A focus call being accepted is not proof that WindowServer actually
    // granted frontmost activation. Keep the one-shot pending until either the
    // browser-window-focus event (or an immediate isFocused() read) confirms
    // success, then retry only a small bounded number of times.
    deps.onEvent?.('focus-window');
    focusAttempts += 1;
    deps.focusWindow();
    if (!pending) return;
    const afterFocus = deps.readWindowState();
    if (afterFocus.focused || windowFocusObserved) {
      pending = false;
      return;
    }
    if (focusAttempts >= maxFocusAttempts) {
      pending = false;
      deps.onEvent?.('abandoned-unfocused');
      return;
    }
    scheduledHandle = deps.schedule(settle, settleDelayMs);
  };

  const scheduleIfReady = (): void => {
    if (!pending || !windowReady || scheduledHandle !== null) return;
    const windowState = deps.readWindowState();
    if (!windowState.exists) return;
    if (windowState.focused || windowFocusObserved) {
      pending = false;
      return;
    }
    if (screenState === 'locked') {
      deps.onEvent?.('deferred-locked');
      return;
    }
    scheduledHandle = deps.schedule(settle, settleDelayMs);
  };

  return {
    arm: () => {
      pending = true;
      windowReady = false;
      windowFocusObserved = false;
      consecutiveUnknownReads = 0;
      focusAttempts = 0;
      screenState = 'unknown';
      refreshScreenState();
    },
    onWindowReady: () => {
      windowReady = true;
      refreshScreenState();
      scheduleIfReady();
    },
    onWindowFocused: () => {
      windowFocusObserved = true;
      if (!pending || !windowReady) return;
      pending = false;
      cancelScheduled();
    },
    onScreenLock: () => {
      screenState = 'locked';
      focusAttempts = 0;
      cancelScheduled();
    },
    onScreenUnlock: () => {
      screenState = 'active';
      consecutiveUnknownReads = 0;
      focusAttempts = 0;
      scheduleIfReady();
    },
    dispose: () => {
      cancelScheduled();
      pending = false;
    },
  };
}
