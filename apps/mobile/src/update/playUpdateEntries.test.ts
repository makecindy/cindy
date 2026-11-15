import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playInstall: vi.fn(() => true),
  fetchLatest: vi.fn<() => Promise<unknown>>(async () => null),
  download: vi.fn<(_url: string, signal: AbortSignal) => Promise<string>>(async () => 'ready.apk'),
  install: vi.fn(async () => undefined),
  checkOta: vi.fn(async () => ({ isAvailable: false })),
  fetchOta: vi.fn(async () => ({ isNew: false })),
  appStateListener: null as ((state: string) => void) | null,
  cleanup: null as (() => void) | null,
}));

// Exercise the update hooks' real effects and callbacks without rendering the full app.
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    mocks.cleanup = typeof cleanup === 'function' ? cleanup : null;
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  AppState: {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      mocks.appStateListener = listener;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock('expo-updates', () => ({
  isEnabled: true,
  runtimeVersion: 'runtime-1',
  checkForUpdateAsync: mocks.checkOta,
  fetchUpdateAsync: mocks.fetchOta,
}));
vi.mock('@/config/env', () => ({
  APP_BINARY_VERSION: '1.0.0',
  IS_OTA_SELFHOST: true,
  IS_TESTFLIGHT_BUILD: false,
  REVIEW_MODE: false,
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('./androidInstallSource', () => ({ isGooglePlayInstallation: mocks.playInstall }));
vi.mock('./androidInstaller', async () => {
  const { AndroidInstallController } = await import('./androidInstallController');
  return { androidInstaller: new AndroidInstallController({
    supported: () => true, hasPermission: async () => true, requestPermission: async () => true,
    download: mocks.download, install: mocks.install, waitForForeground: async () => undefined,
    remove: async () => undefined, openBrowser: async () => undefined,
  }) };
});
vi.mock('./fetchLatestRelease', () => ({ fetchLatestRelease: mocks.fetchLatest }));
vi.mock('./forcedUpdateStore', () => ({ enterForcedUpdate: vi.fn() }));
vi.mock('./canaryChannelStore', () => ({ resolveUpdateChannelForDevice: () => 'release' }));
vi.mock('./otaRequestCoordinator', () => ({
  runSelfHostedOtaRequest: (_channel: string, operation: (client: {
    checkForUpdateAsync: typeof mocks.checkOta;
    fetchUpdateAsync: typeof mocks.fetchOta;
  }) => Promise<unknown>) => operation({
    checkForUpdateAsync: mocks.checkOta,
    fetchUpdateAsync: mocks.fetchOta,
  }),
}));

import { useBundleUpdatePrompt } from './useBundleUpdatePrompt';
import { useResumeUpdateCheck } from './useResumeUpdateCheck';
import { runManualUpdateCheck } from './manualUpdateCheck';
import { androidInstaller } from './androidInstaller';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.playInstall.mockReturnValue(true);
  mocks.appStateListener = null;
  mocks.cleanup = null;
  mocks.fetchLatest.mockResolvedValue(null);
});

afterEach(() => {
  mocks.cleanup?.();
  androidInstaller.cancel();
  vi.restoreAllMocks();
});

describe('Google Play update entry points', () => {
  // PR #6977: root channel cleanup must also own transfers started by resume.
  // Existing checks only blocked late manifests, not an already-started download.
  it('cancels a resume download on channel change even when the next channel has no update', async () => {
    mocks.playInstall.mockReturnValue(false);
    useBundleUpdatePrompt({ auto: true, channel: 'canary' });
    const rootCleanup = mocks.cleanup;
    let complete!: (file: string) => void;
    let oldSignal!: AbortSignal;
    mocks.download.mockImplementationOnce((_url, signal) => {
      oldSignal = signal;
      return new Promise((resolve) => { complete = resolve; });
    });
    mocks.fetchLatest.mockResolvedValueOnce({ version: '2.0.0', runtimeVersion: 'new',
      installUrl: 'https://updates.example.invalid/app.apk', itmsUrl: '' });
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(300_001);
    useResumeUpdateCheck('canary');
    const resumeCleanup = mocks.cleanup;
    mocks.appStateListener!('background'); mocks.appStateListener!('active');
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    rootCleanup?.(); resumeCleanup?.();
    expect(oldSignal.aborted).toBe(true);
    useBundleUpdatePrompt({ auto: true, channel: 'release' });
    complete('old-canary.apk');
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(androidInstaller.getSnapshot().phase).toBe('idle');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('startup hook skips the website release check', async () => {
    const { checkNow } = useBundleUpdatePrompt({ auto: true, channel: 'release' });
    await expect(checkNow()).resolves.toBe('skipped');
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
  });

  it('resume checks content OTA but never asks for the website APK', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(300_001);
    useResumeUpdateCheck('release');
    expect(mocks.appStateListener).not.toBeNull();
    mocks.appStateListener!('background');
    mocks.appStateListener!('active');
    await vi.waitFor(() => expect(mocks.checkOta).toHaveBeenCalledOnce());
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('settings passes no website check and can still check content OTA', async () => {
    await expect(runManualUpdateCheck({
      checkBundleUpdate: undefined,
      otaEnabled: true,
      checkOtaUpdate: mocks.checkOta,
      fetchOtaUpdate: mocks.fetchOta,
      reload: vi.fn(async () => undefined),
      isEmergencyLaunch: () => false,
      onPhase: vi.fn(),
    })).resolves.toEqual({ kind: 'up-to-date' });
    expect(mocks.checkOta).toHaveBeenCalledOnce();
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
  });
});
