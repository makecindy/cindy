export type MobileVoiceRecordingPermission = {
  granted: boolean;
};

export type MobileVoicePermissionResult = 'granted' | 'denied' | 'cancelled';

type ResolveMobileVoiceRecordingPermissionOptions = {
  getPermission: () => Promise<MobileVoiceRecordingPermission>;
  requestPermission: () => Promise<MobileVoiceRecordingPermission>;
  isRequestCurrent: () => boolean;
  isAppActive: () => boolean;
  subscribeToAppState: (listener: (state: string) => void) => () => void;
  signal: AbortSignal;
  waitForAppActive: () => Promise<boolean>;
};

type MobileVoiceBackgroundState = {
  startupInFlight: boolean;
  recordingActive: boolean;
  hasController: boolean;
};

type WaitForMobileVoiceAppActiveOptions = {
  isAppActive: () => boolean;
  subscribe: (listener: (state: string) => void) => () => void;
  signal: AbortSignal;
};

/**
 * Waits for React Native to publish the foreground transition that can trail
 * Android's permission result. The caller aborts this wait when its screen or
 * permission request is superseded, which also removes the AppState listener.
 */
export function waitForMobileVoiceAppActive(
  options: WaitForMobileVoiceAppActiveOptions,
): Promise<boolean> {
  if (options.isAppActive()) return Promise.resolve(true);
  if (options.signal.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      options.signal.removeEventListener('abort', onAbort);
      resolve(active);
    };
    const onAbort = (): void => finish(false);

    options.signal.addEventListener('abort', onAbort, { once: true });
    const removeSubscription = options.subscribe((state) => {
      if (state === 'active') finish(true);
    });
    // A synchronous subscription callback may settle before subscribe returns.
    if (settled) {
      removeSubscription();
      return;
    }
    unsubscribe = removeSubscription;
    // Close the gap between the initial check and listener registration.
    if (options.isAppActive()) finish(true);
    else if (options.signal.aborted) finish(false);
  });
}

/**
 * Resolves microphone permission before voice startup claims any audio
 * resources. Android may report the app as backgrounded while its system
 * permission sheet is open, and the permission promise can resolve before the
 * matching foreground event. Only backgrounding after the system prompt opens
 * may wait for active; a tap that backgrounds during permission preflight is
 * stale even if the app returns before the permission query resolves.
 */
export async function resolveMobileVoiceRecordingPermission(
  options: ResolveMobileVoiceRecordingPermissionOptions,
): Promise<MobileVoicePermissionResult> {
  if (
    options.signal.aborted
    || !options.isRequestCurrent()
    || !options.isAppActive()
  ) return 'cancelled';

  let backgroundedDuringPreflight = false;
  let removePreflightSubscription: (() => void) | null = options.subscribeToAppState((state) => {
    if (state === 'background') backgroundedDuringPreflight = true;
  });
  const stopObservingPreflight = (): void => {
    removePreflightSubscription?.();
    removePreflightSubscription = null;
  };
  const onAbort = (): void => stopObservingPreflight();
  options.signal.addEventListener('abort', onAbort, { once: true });
  let permission: MobileVoiceRecordingPermission;
  try {
    permission = await options.getPermission();
  } finally {
    stopObservingPreflight();
    options.signal.removeEventListener('abort', onAbort);
  }
  if (
    options.signal.aborted
    || !options.isRequestCurrent()
    || backgroundedDuringPreflight
    || !options.isAppActive()
  ) return 'cancelled';

  let openedSystemPrompt = false;
  if (!permission.granted) {
    openedSystemPrompt = true;
    permission = await options.requestPermission();
    if (options.signal.aborted || !options.isRequestCurrent()) return 'cancelled';
  }

  if (!permission.granted) return 'denied';
  if (!options.isAppActive()) {
    if (!openedSystemPrompt) return 'cancelled';
    const becameActive = await options.waitForAppActive();
    if (
      !becameActive
      || !options.isRequestCurrent()
      || !options.isAppActive()
    ) return 'cancelled';
  }
  return 'granted';
}

/**
 * Permission prompts do not own a controller or an active audio session.
 * Backgrounding cancels only startup work that has moved past permission, or
 * a recording that is already active.
 */
export function shouldCancelMobileVoiceForBackground(
  state: MobileVoiceBackgroundState,
): boolean {
  return state.startupInFlight || state.recordingActive || state.hasController;
}
