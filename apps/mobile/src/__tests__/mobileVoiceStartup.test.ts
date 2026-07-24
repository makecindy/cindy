import { describe, expect, it, vi } from 'vitest';
import {
  resolveMobileVoiceRecordingPermission,
  shouldCancelMobileVoiceForBackground,
} from '@/session/mobileVoiceStartup';

function deferredPermission(): {
  promise: Promise<{ granted: boolean }>;
  resolve: (permission: { granted: boolean }) => void;
} {
  let resolve!: (permission: { granted: boolean }) => void;
  const promise = new Promise<{ granted: boolean }>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('mobileVoiceStartup', () => {
  it('uses an existing microphone grant without opening the system prompt', async () => {
    const requestPermission = vi.fn(async () => ({ granted: true }));

    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: true }),
      requestPermission,
      isRequestCurrent: () => true,
      isAppActive: () => true,
    })).resolves.toBe('granted');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('survives Android background/active transitions caused by the first permission prompt', async () => {
    const pendingPermission = deferredPermission();
    let appActive = true;
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: () => pendingPermission.promise,
      isRequestCurrent: () => true,
      isAppActive: () => appActive,
    });

    await Promise.resolve();
    appActive = false;
    expect(shouldCancelMobileVoiceForBackground({
      permissionRequestInFlight: true,
      startupInFlight: false,
      recordingActive: false,
      hasController: false,
    })).toBe(false);

    appActive = true;
    pendingPermission.resolve({ granted: true });
    await expect(result).resolves.toBe('granted');
  });

  it('reports a denied microphone request', async () => {
    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: async () => ({ granted: false }),
      isRequestCurrent: () => true,
      isAppActive: () => true,
    })).resolves.toBe('denied');
  });

  it('does not start recording while the app is genuinely backgrounded', async () => {
    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: true }),
      requestPermission: async () => ({ granted: true }),
      isRequestCurrent: () => true,
      isAppActive: () => false,
    })).resolves.toBe('cancelled');
    expect(shouldCancelMobileVoiceForBackground({
      permissionRequestInFlight: false,
      startupInFlight: true,
      recordingActive: false,
      hasController: false,
    })).toBe(true);
  });

  it('cancels a granted request when the screen is superseded while the prompt is open', async () => {
    const pendingPermission = deferredPermission();
    let requestCurrent = true;
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: () => pendingPermission.promise,
      isRequestCurrent: () => requestCurrent,
      isAppActive: () => true,
    });

    await Promise.resolve();
    requestCurrent = false;
    pendingPermission.resolve({ granted: true });
    await expect(result).resolves.toBe('cancelled');
  });
});
