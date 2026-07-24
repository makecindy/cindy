export type MobileVoiceRecordingPermission = {
  granted: boolean;
};

export type MobileVoicePermissionResult = 'granted' | 'denied' | 'cancelled';

type ResolveMobileVoiceRecordingPermissionOptions = {
  getPermission: () => Promise<MobileVoiceRecordingPermission>;
  requestPermission: () => Promise<MobileVoiceRecordingPermission>;
  isRequestCurrent: () => boolean;
  isAppActive: () => boolean;
};

type MobileVoiceBackgroundState = {
  permissionRequestInFlight: boolean;
  startupInFlight: boolean;
  recordingActive: boolean;
  hasController: boolean;
};

/**
 * Resolves microphone permission before voice startup claims any audio
 * resources. Android may report the app as backgrounded while its system
 * permission sheet is open, so cancellation is checked after each await and
 * foreground state is required only when permission resolution completes.
 */
export async function resolveMobileVoiceRecordingPermission(
  options: ResolveMobileVoiceRecordingPermissionOptions,
): Promise<MobileVoicePermissionResult> {
  let permission = await options.getPermission();
  if (!options.isRequestCurrent()) return 'cancelled';

  if (!permission.granted) {
    permission = await options.requestPermission();
    if (!options.isRequestCurrent()) return 'cancelled';
  }

  if (!permission.granted) return 'denied';
  return options.isAppActive() ? 'granted' : 'cancelled';
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
