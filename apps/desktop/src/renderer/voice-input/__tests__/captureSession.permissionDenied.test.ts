import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startVoiceInputCaptureSession } from '../captureSession';

const engineStart = vi.fn<() => Promise<void>>();

vi.mock('../WebMicAudioEngine', () => ({
  WebMicAudioEngine: class {
    onPcm16k() {}
    start() {
      return engineStart();
    }
    stop() {
      return Promise.resolve();
    }
  },
  currentPowerReleaseGeneration: () => 0,
  isMicrophonePermissionDeniedError: (error: unknown) =>
    (error as { name?: string } | null)?.name === 'NotAllowedError',
  isPowerReleaseCancellation: () => false,
  isSelectedMicrophoneUnavailableError: () => false,
  powerReleaseCancellation: () => new Error('power release'),
}));

vi.mock('../audioProfile', () => ({
  createVoiceInputAudioProfile: () => ({}),
}));

function startSession() {
  return startVoiceInputCaptureSession({
    label: 'test',
    workletUrl: 'blob:worklet',
    fastActivationEnabled: false,
    getRunId: () => null,
    setEngine: () => undefined,
    appendAudioChunk: () => undefined,
    onInterrupted: () => undefined,
    onStateChange: () => undefined,
    getFallbackMessage: () => 'fallback',
    onFallback: () => undefined,
    formatStartError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}

describe('startVoiceInputCaptureSession permission revocation', () => {
  let setRendererMicrophonePermissionVerified: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setRendererMicrophonePermissionVerified = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      electronAPI: {
        voiceInput: { setRendererMicrophonePermissionVerified },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    engineStart.mockReset();
  });

  it('reports permissionDenied and invalidates the cached permission when getUserMedia is not allowed', async () => {
    engineStart.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

    const result = await startSession();

    expect(result).toMatchObject({ ok: false, permissionDenied: true, error: 'Permission denied' });
    expect(setRendererMicrophonePermissionVerified).toHaveBeenCalledWith(false);
  });

  it('leaves other capture failures on the generic error path', async () => {
    engineStart.mockRejectedValue(new DOMException('Device busy', 'NotReadableError'));

    const result = await startSession();

    expect(result).toMatchObject({ ok: false, error: 'Device busy' });
    expect((result as { permissionDenied?: boolean }).permissionDenied).toBeUndefined();
    expect(setRendererMicrophonePermissionVerified).not.toHaveBeenCalled();
  });
});
