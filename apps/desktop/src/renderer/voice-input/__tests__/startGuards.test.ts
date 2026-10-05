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

  it.each(['unknown', 'denied'])('leaves %s permission to the real capture without opening a probe', async (status) => {
    const apis = stubVoiceInputApis('win32', { ok: false, status, error: 'Permission required' });
    const result = await resolveVoiceInputStartGuards();
    expect(result).toMatchObject({ ok: true, permissionSource: 'capture' });
    expect(apis.getUserMedia).not.toHaveBeenCalled();
    expect(apis.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(apis.setRendererMicrophonePermissionVerified).not.toHaveBeenCalled();
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
