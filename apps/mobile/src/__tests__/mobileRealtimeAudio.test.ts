import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  EventEmitter: class {
    addListener() {
      return { remove: vi.fn() };
    }
  },
  UnavailabilityError: class extends Error {
    constructor(moduleName: string, propertyName: string) {
      super(`${moduleName}.${propertyName} is unavailable`);
      this.name = 'UnavailabilityError';
    }
  },
  requireNativeModule: vi.fn(() => {
    throw new Error('native module not linked');
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mobileRealtimeAudio', () => {
  it('decodes native PCM base64 payloads into ArrayBuffer chunks', async () => {
    const { __testing } = await import('@/session/mobileRealtimeAudio');

    const decoded = new Uint8Array(__testing.decodeBase64ToArrayBuffer('AQIDBA=='));

    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  it('reports realtime audio as unavailable when the dev client has not linked the native module', async () => {
    const {
      __testing,
      isMobileRealtimeAudioAvailable,
      startMobileRealtimeAudio,
    } = await import('@/session/mobileRealtimeAudio');

    __testing.resetNativeBindingForTests();

    expect(isMobileRealtimeAudioAvailable()).toBe(false);
    await expect(startMobileRealtimeAudio({ onChunk: vi.fn() }))
      .rejects.toThrow('realtime microphone PCM capture');
  });

  it('hides voice UI on Android without changing existing non-Android surfaces', async () => {
    const { shouldShowMobileVoiceUi } = await import('@/session/mobileRealtimeAudio');

    expect(shouldShowMobileVoiceUi('android')).toBe(false);
    expect(shouldShowMobileVoiceUi('ios')).toBe(true);
    expect(shouldShowMobileVoiceUi('web')).toBe(true);
  });

  it('keeps the Android voice entry available to explicit E2E mock runs', async () => {
    vi.stubEnv('EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO', '1');
    const { shouldShowMobileVoiceUi } = await import('@/session/mobileRealtimeAudio');

    expect(shouldShowMobileVoiceUi('android')).toBe(true);
  });

  it('keeps the iOS native realtime recorder wired for interruption cleanup', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/ios/XdtMobileRealtimeAudioModule.swift'),
      'utf8',
    );

    expect(source).toContain('AVAudioSession.interruptionNotification');
    expect(source).toContain('AVAudioSession.routeChangeNotification');
    expect(source).toContain('removeAudioSessionObservers()');
    expect(source).toContain('handleAudioSessionInterruption');
    expect(source).toContain('handleAudioRouteChange');
    expect(source).toContain('OnAppEntersBackground');
    expect(source).toContain('stopCapture(deactivateImmediately: true)');
    expect(source).toContain('stopCapture()');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionInterruptionTypeKey])');
    expect(source).toContain('unsignedIntegerValue(notification.userInfo?[AVAudioSessionRouteChangeReasonKey])');
  });

  it('cancels voice runs in both composers when the app enters the background', () => {
    const newSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/new.tsx'),
      'utf8',
    );
    const existingSessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    );

    for (const source of [newSessionSource, existingSessionSource]) {
      expect(source).toContain("AppState.addEventListener('change'");
      expect(source).toContain("nextState !== 'background'");
      expect(source).toContain('voiceControllerSessionRef.current = null');
      expect(source).toContain('discardPendingPrewarm()');
      expect(source).toContain("setAudioModeAsync({ allowsRecording: false })");
    }
    expect(newSessionSource).toContain('cancelVoiceForDeviceSwitch();');
    expect(existingSessionSource).toContain('cancelVoiceForAppBackground();');
  });
});
