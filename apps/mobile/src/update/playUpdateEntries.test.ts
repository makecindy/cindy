import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playInstall: vi.fn(() => true),
  fetchLatest: vi.fn(async () => null),
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
vi.mock('./androidInstaller', () => ({ androidInstaller: { start: vi.fn() } }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.playInstall.mockReturnValue(true);
  mocks.appStateListener = null;
  mocks.cleanup = null;
});

afterEach(() => {
  mocks.cleanup?.();
  vi.restoreAllMocks();
});

describe('Google Play update entry points', () => {
  it('startup hook skips the website release check', async () => {
    const { checkNow } = useBundleUpdatePrompt({ auto: true, channel: 'release' });
    await expect(checkNow()).resolves.toBe('skipped');
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
    // The root layout still mounts its independent startup content OTA gate.
    const layout = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
    expect(layout).toContain('const otaReady = useStartupOtaGate(channel);');
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
    const settings = readFileSync(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
    expect(settings).toContain('isGooglePlayInstallation: playManagedUpdates,');
    expect(settings).toContain('checkBundleUpdate: bundleCheckEnabled ? checkBundleUpdate : undefined,');
    expect(settings).toContain('const updateCheckEnabled = bundleCheckEnabled || updatesEnabled;');
    expect(settings).toContain("t('settings.version.googlePlayContentUpdateUnavailable')");
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
