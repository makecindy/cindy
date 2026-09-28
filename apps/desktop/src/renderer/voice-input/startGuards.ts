type VoiceInputPermissionResult =
  | { ok: true; status?: string }
  | { ok: false; status?: string; error: string };

type VoiceInputReadinessResult = Awaited<ReturnType<typeof window.electronAPI.voiceInput.getReadiness>>;

type VoiceInputStartGuardsOptions = {
  requireAccessibility?: boolean;
};

export type VoiceInputStartGuardsResult =
  | {
      ok: true;
      permission: Extract<VoiceInputPermissionResult, { ok: true }>;
      accessibility: Extract<VoiceInputPermissionResult, { ok: true }>;
      readiness: VoiceInputReadinessResult;
      permissionSource: 'cache' | 'capture';
      accessibilitySource: 'cache';
      readinessSource: 'cache' | 'async';
    }
  | {
      ok: false;
      failed: 'permission' | 'accessibility' | 'readiness';
      permission: VoiceInputPermissionResult;
      accessibility: VoiceInputPermissionResult;
      readiness: VoiceInputReadinessResult;
      permissionSource: 'cache' | 'capture';
      accessibilitySource: 'cache';
      readinessSource: 'cache' | 'async';
    };

async function refreshMicrophonePermissionSnapshot(): Promise<VoiceInputPermissionResult> {
  const permissions = await window.electronAPI.voiceInput.getSystemPermissions();
  return permissions.microphone;
}

/**
 * Request microphone access from the renderer process because Electron captures
 * audio from renderer/helper processes. This makes macOS TCC register the same
 * executable that will later call getUserMedia for real dictation, while main's
 * `askForMediaAccess` remains a fallback/status refresh path.
 */
export async function requestRendererMicrophonePermission(): Promise<VoiceInputPermissionResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return window.electronAPI.voiceInput.requestMicrophonePermission();
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    await window.electronAPI.voiceInput.setRendererMicrophonePermissionVerified(true);
    const refreshed = await refreshMicrophonePermissionSnapshot();
    return refreshed.ok ? refreshed : { ok: true, status: 'granted' };
  } catch (error) {
    await window.electronAPI.voiceInput.setRendererMicrophonePermissionVerified(false);
    const mainResult = await window.electronAPI.voiceInput.requestMicrophonePermission();
    if (mainResult.ok) return mainResult;

    const refreshed = await refreshMicrophonePermissionSnapshot().catch(() => null);
    if (refreshed?.ok) return refreshed;

    return {
      ok: false,
      status: refreshed?.status,
      error:
        refreshed?.error ??
        (error instanceof Error
          ? error.message
          : mainResult.error || 'Microphone permission is required for voice input.'),
    };
  }
}

/**
 * Check service/accessibility readiness alongside local capture.
 *
 * The capture engine's getUserMedia is the microphone permission request and
 * authoritative check, including first use and revocation. Never open a probe
 * stream here: closing it then reopening capture costs a second device startup
 * and loses anything spoken into the probe. Main still verifies service auth.
 */
export async function resolveVoiceInputStartGuards(
  options: VoiceInputStartGuardsOptions = {},
): Promise<VoiceInputStartGuardsResult> {
  const cachedPermission = window.electronAPI.voiceInput.getMicrophonePermissionCached();
  const cachedSystemPermissions = window.electronAPI.voiceInput.getSystemPermissionsCached();
  const accessibility = options.requireAccessibility
    ? cachedSystemPermissions.accessibility
    : ({ ok: true, status: 'not-required' } as const);
  const cachedReadiness = window.electronAPI.voiceInput.getReadinessCached();
  const permissionSource = cachedPermission.ok && cachedPermission.status === 'granted'
    ? 'cache' : 'capture';
  const readinessSource = cachedReadiness?.ok ? 'cache' : 'async';

  const permission: VoiceInputPermissionResult = permissionSource === 'cache'
    ? cachedPermission
    : { ok: true, status: 'checked-by-capture' };
  const readinessPromise: Promise<VoiceInputReadinessResult> = cachedReadiness?.ok
    ? Promise.resolve(cachedReadiness)
    : window.electronAPI.voiceInput.getReadiness();

  const readiness = await readinessPromise;
  if (!permission.ok) {
    return {
      ok: false,
      failed: 'permission',
      permission,
      accessibility,
      readiness,
      permissionSource,
      accessibilitySource: 'cache',
      readinessSource,
    };
  }
  if (!accessibility.ok) {
    return {
      ok: false,
      failed: 'accessibility',
      permission,
      accessibility,
      readiness,
      permissionSource,
      accessibilitySource: 'cache',
      readinessSource,
    };
  }
  if (!readiness.ok) {
    return {
      ok: false,
      failed: 'readiness',
      permission,
      accessibility,
      readiness,
      permissionSource,
      accessibilitySource: 'cache',
      readinessSource,
    };
  }
  return {
    ok: true,
    permission,
    accessibility,
    readiness,
    permissionSource,
    accessibilitySource: 'cache',
    readinessSource,
  };
}
