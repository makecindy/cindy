import { describe, expect, it, vi } from 'vitest';
import {
  resolveMobileVoiceRecordingPermission,
  shouldClearMobileVoiceStartPending,
  shouldCancelMobileVoiceForBackground,
  waitForMobileVoiceAppActive,
} from '@/session/mobileVoiceStartup';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function stableAppStateLifecycle(): {
  signal: AbortSignal;
  subscribeToAppState: () => () => void;
} {
  return {
    signal: new AbortController().signal,
    subscribeToAppState: () => () => undefined,
  };
}

describe('mobileVoiceStartup', () => {
  it('keeps the optimistic pill while startup settles before the first PCM chunk', () => {
    expect(shouldClearMobileVoiceStartPending({
      voiceState: 'idle',
      startupSettled: true,
      recordingActive: true,
      hasController: true,
    })).toBe(false);
  });

  it('clears a settled startup after cancellation releases the controller', () => {
    expect(shouldClearMobileVoiceStartPending({
      voiceState: 'idle',
      startupSettled: true,
      recordingActive: false,
      hasController: false,
    })).toBe(true);
  });

  it.each(['listening', 'submitting', 'refining'] as const)(
    'clears the optimistic pill once voice state is %s',
    (voiceState) => {
      expect(shouldClearMobileVoiceStartPending({
        voiceState,
        startupSettled: false,
        recordingActive: true,
        hasController: true,
      })).toBe(true);
    },
  );

  it.each(['error', 'done'] as const)('keeps a stale terminal voice state %s while the new controller is active', (voiceState) => {
    expect(shouldClearMobileVoiceStartPending({
      voiceState,
      startupSettled: true,
      recordingActive: true,
      hasController: true,
    })).toBe(false);
  });

  it.each([
    { voiceState: 'idle', reason: 'no active recording' },
    { voiceState: 'error', reason: 'startup failure' },
    { voiceState: 'done', reason: 'cancelled previous run' },
  ] as const)('clears the optimistic pill after %s', ({ voiceState }) => {
    expect(shouldClearMobileVoiceStartPending({
      voiceState,
      startupSettled: true,
      recordingActive: false,
      hasController: false,
    })).toBe(true);
  });

  it('uses an existing microphone grant without opening the system prompt', async () => {
    const requestPermission = vi.fn(async () => ({ granted: true }));

    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: true }),
      requestPermission,
      ...stableAppStateLifecycle(),
      isRequestCurrent: () => true,
      isAppActive: () => true,
      waitForAppActive: async () => true,
    })).resolves.toBe('granted');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('does not open the system prompt after backgrounding during permission preflight', async () => {
    const pendingPermission = deferred<{ granted: boolean }>();
    const requestPermission = vi.fn(async () => ({ granted: true }));
    const abortController = new AbortController();
    const unsubscribe = vi.fn();
    let publishAppState = (_state: string): void => undefined;
    let appActive = true;
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: () => pendingPermission.promise,
      requestPermission,
      isRequestCurrent: () => true,
      isAppActive: () => appActive,
      subscribeToAppState: (listener) => {
        publishAppState = listener;
        return unsubscribe;
      },
      signal: abortController.signal,
      waitForAppActive: async () => true,
    });

    appActive = false;
    publishAppState('background');
    appActive = true;
    pendingPermission.resolve({ granted: false });

    await expect(result).resolves.toBe('cancelled');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('removes the preflight listener when the permission request is aborted', async () => {
    const pendingPermission = deferred<{ granted: boolean }>();
    const abortController = new AbortController();
    const unsubscribe = vi.fn();
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: () => pendingPermission.promise,
      requestPermission: async () => ({ granted: true }),
      isRequestCurrent: () => true,
      isAppActive: () => true,
      subscribeToAppState: () => unsubscribe,
      signal: abortController.signal,
      waitForAppActive: async () => true,
    });

    abortController.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    pendingPermission.resolve({ granted: false });
    await expect(result).resolves.toBe('cancelled');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('waits for Android to publish active after the first permission prompt resolves', async () => {
    const pendingPermission = deferred<{ granted: boolean }>();
    const pendingForeground = deferred<boolean>();
    let appActive = true;
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: () => pendingPermission.promise,
      ...stableAppStateLifecycle(),
      isRequestCurrent: () => true,
      isAppActive: () => appActive,
      waitForAppActive: () => pendingForeground.promise,
    });

    await Promise.resolve();
    appActive = false;
    expect(shouldCancelMobileVoiceForBackground({
      startupInFlight: false,
      recordingActive: false,
      hasController: false,
    })).toBe(false);

    pendingPermission.resolve({ granted: true });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    appActive = true;
    pendingForeground.resolve(true);
    await expect(result).resolves.toBe('granted');
  });

  it('reports a denied microphone request', async () => {
    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: async () => ({ granted: false }),
      ...stableAppStateLifecycle(),
      isRequestCurrent: () => true,
      isAppActive: () => true,
      waitForAppActive: async () => true,
    })).resolves.toBe('denied');
  });

  it('cancels an already-granted request that genuinely backgrounds', async () => {
    const waitForAppActive = vi.fn(async () => true);
    await expect(resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: true }),
      requestPermission: async () => ({ granted: true }),
      ...stableAppStateLifecycle(),
      isRequestCurrent: () => true,
      isAppActive: () => false,
      waitForAppActive,
    })).resolves.toBe('cancelled');
    expect(waitForAppActive).not.toHaveBeenCalled();
    expect(shouldCancelMobileVoiceForBackground({
      startupInFlight: true,
      recordingActive: false,
      hasController: false,
    })).toBe(true);
  });

  it('cancels a granted request when the screen is superseded while the prompt is open', async () => {
    const pendingPermission = deferred<{ granted: boolean }>();
    let requestCurrent = true;
    const result = resolveMobileVoiceRecordingPermission({
      getPermission: async () => ({ granted: false }),
      requestPermission: () => pendingPermission.promise,
      ...stableAppStateLifecycle(),
      isRequestCurrent: () => requestCurrent,
      isAppActive: () => true,
      waitForAppActive: async () => true,
    });

    await Promise.resolve();
    requestCurrent = false;
    pendingPermission.resolve({ granted: true });
    await expect(result).resolves.toBe('cancelled');
  });

  it('removes the foreground listener when a waiting screen is superseded', async () => {
    let appStateListener: ((state: string) => void) | null = null;
    const unsubscribe = vi.fn();
    const abortController = new AbortController();
    const result = waitForMobileVoiceAppActive({
      isAppActive: () => false,
      subscribe: (listener) => {
        appStateListener = listener;
        return unsubscribe;
      },
      signal: abortController.signal,
    });

    expect(appStateListener).not.toBeNull();
    abortController.abort();
    await expect(result).resolves.toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
