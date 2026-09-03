import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveVoiceInputStartGuards } from '../startGuards';

const grantedPermission = { ok: true as const, status: 'granted' };
type PermissionSnapshot =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };
const ready = {
  ok: true,
  provider: 'litellm',
  providerModel: 'test-model',
  auth: 'api-key' as const,
  settingsTab: 'api-keys' as const,
};

function stubVoiceInputApis(
  platform: 'darwin' | 'win32',
  microphonePermission: PermissionSnapshot = grantedPermission,
) {
  const getUserMedia = vi.fn();
  const setRendererMicrophonePermissionVerified = vi.fn(async () => ({ ok: true as const }));
  const requestMicrophonePermission = vi.fn();
  const getSystemPermissions = vi.fn();

  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('window', {
    electronAPI: {
      platform,
      voiceInput: {
        getMicrophonePermissionCached: vi.fn(() => microphonePermission),
        getSystemPermissionsCached: vi.fn(() => ({
          microphone: grantedPermission,
          inputMonitoring: grantedPermission,
          accessibility: grantedPermission,
        })),
        getReadinessCached: vi.fn(() => ready),
        getReadiness: vi.fn(async () => ready),
        getSystemPermissions,
        requestMicrophonePermission,
        setRendererMicrophonePermissionVerified,
      },
    },
  });

  return {
    getUserMedia,
    getSystemPermissions,
    requestMicrophonePermission,
    setRendererMicrophonePermissionVerified,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveVoiceInputStartGuards', () => {
  it('uses a positive Windows permission cache without opening a probe stream', async () => {
    const apis = stubVoiceInputApis('win32');
    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: true,
      permission: grantedPermission,
      permissionSource: 'cache',
    });
    expect(apis.getUserMedia).not.toHaveBeenCalled();
    expect(apis.setRendererMicrophonePermissionVerified).not.toHaveBeenCalled();
  });

  it('refreshes a missing Windows permission cache before allowing voice input to start', async () => {
    const unknownPermission = {
      ok: false as const,
      status: 'unknown',
      error: 'Microphone permission is required for voice input. Enable it in Windows Settings.',
    };
    const apis = stubVoiceInputApis('win32', unknownPermission);
    const denial = {
      ok: false as const,
      status: 'denied',
      error: 'Microphone permission is required for voice input. Enable it in Windows Settings.',
    };
    apis.getUserMedia.mockRejectedValue(new Error('Permission denied'));
    apis.requestMicrophonePermission.mockResolvedValue(denial);
    apis.getSystemPermissions.mockResolvedValue({
      microphone: denial,
      inputMonitoring: grantedPermission,
      accessibility: grantedPermission,
    });

    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: false,
      failed: 'permission',
      permission: denial,
      permissionSource: 'async',
    });
    expect(apis.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(apis.setRendererMicrophonePermissionVerified).toHaveBeenCalledWith(false);
  });

  it('keeps trusting a positive macOS cache on the start path', async () => {
    const apis = stubVoiceInputApis('darwin');

    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: true,
      permission: grantedPermission,
      permissionSource: 'cache',
    });
    expect(apis.getUserMedia).not.toHaveBeenCalled();
  });
});
