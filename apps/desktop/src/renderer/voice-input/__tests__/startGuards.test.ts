import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestRendererMicrophonePermission, resolveVoiceInputStartGuards } from '../startGuards';

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

// The explicit microphone action used to request OS access for an absent or busy
// device, and could overwrite a fresh system denial with a successful trial.
describe('requestRendererMicrophonePermission', () => {
  it.each(['NotFoundError', 'NotReadableError', 'AbortError'])('reports %s without a second OS request', async name => {
    const apis = stubVoiceInputApis('darwin');
    apis.getUserMedia.mockRejectedValue(new DOMException('Input unavailable', name));
    expect(await requestRendererMicrophonePermission()).toMatchObject({ ok: false, status: 'device-unavailable' });
    expect(apis.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(apis.setRendererMicrophonePermissionVerified).not.toHaveBeenCalled();
  });
  it('honors an explicit system denial after a successful microphone trial', async () => {
    const apis = stubVoiceInputApis('darwin');
    const stop = vi.fn();
    const denied = { ok: false, status: 'denied', error: 'Denied' };
    apis.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    apis.getSystemPermissions.mockResolvedValue({ microphone: denied });
    expect(await requestRendererMicrophonePermission()).toEqual(denied);
    expect(stop).toHaveBeenCalledOnce();
  });
  it('releases the trial stream without repeating a native request when only the status IPC fails', async () => {
    const apis = stubVoiceInputApis('darwin');
    const stop = vi.fn();
    apis.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    apis.getSystemPermissions.mockRejectedValue(new Error('IPC unavailable'));
    expect(await requestRendererMicrophonePermission()).toEqual({ ok: true, status: 'granted' });
    expect(stop).toHaveBeenCalledOnce();
    expect(apis.requestMicrophonePermission).not.toHaveBeenCalled();
  });
});
