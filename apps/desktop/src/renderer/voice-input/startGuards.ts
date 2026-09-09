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
      permissionSource: 'cache' | 'async';
      accessibilitySource: 'cache';
      readinessSource: 'cache' | 'async';
    }
  | {
      ok: false;
      failed: 'permission' | 'accessibility' | 'readiness';
      permission: VoiceInputPermissionResult;
      accessibility: VoiceInputPermissionResult;
      readiness: VoiceInputReadinessResult;
      permissionSource: 'cache' | 'async';
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
 * Resolve the two gates that must pass before voice input is allowed.
 *
 * The synchronous cache is only trusted for positive results. Negative or
 * missing cache values take the existing async path so a just-finished Codex
 * login or a freshly granted microphone permission is not hidden by stale
 * state. Main still verifies readiness in `voice-input:start`; this helper only
 * removes avoidable IPC latency from the renderer-to-microphone critical path.
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
  // A positive OS permission snapshot is sufficient for the start guard. The
  // real capture engine calls getUserMedia immediately after this gate and is
  // the authoritative revocation check; opening a second, short-lived stream
  // here made every Windows recording pay the microphone cold-start cost twice.
  // Keep the async path for missing/negative/unknown snapshots so newly granted
  // permission still takes effect without restarting the app.
  const shouldVerifyPermission = !cachedPermission.ok
    || cachedPermission.status !== 'granted';
  const permissionSource = shouldVerifyPermission ? 'async' : 'cache';
  const readinessSource = cachedReadiness?.ok ? 'cache' : 'async';

  const permissionPromise: Promise<VoiceInputPermissionResult> = shouldVerifyPermission
    ? requestRendererMicrophonePermission()
    : Promise.resolve(cachedPermission);
  const readinessPromise: Promise<VoiceInputReadinessResult> = cachedReadiness?.ok
    ? Promise.resolve(cachedReadiness)
    : window.electronAPI.voiceInput.getReadiness();

  const [permission, readiness] = await Promise.all([permissionPromise, readinessPromise]);
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
