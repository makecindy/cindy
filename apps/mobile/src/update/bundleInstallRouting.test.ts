import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  alert: vi.fn(),
  openURL: vi.fn(async () => undefined),
  start: vi.fn(() => true),
  forced: vi.fn(),
  playInstall: vi.fn(() => false),
}));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert }, Linking: { openURL: mocks.openURL }, Platform: mocks.platform }));
vi.mock('expo-application', () => ({ applicationId: 'com.xd.cindy' }));
vi.mock('expo-updates', () => ({}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/config/env', () => ({ APP_BINARY_VERSION: '1.0.0', IS_OTA_SELFHOST: true, IS_TESTFLIGHT_BUILD: false, REVIEW_MODE: false }));
vi.mock('./androidInstaller', () => ({ androidInstaller: { start: mocks.start } }));
vi.mock('./androidInstallSource', () => ({ isGooglePlayInstallation: mocks.playInstall }));
vi.mock('./forcedUpdateStore', () => ({ enterForcedUpdate: mocks.forced }));
vi.mock('./canaryChannelStore', () => ({ resolveUpdateChannelForDevice: () => 'release' }));
import { openBundleInstall, promptBundleUpdate } from './useBundleUpdatePrompt';
const target = { version: '1.2.3', runtimeVersion: 'new', installUrl: 'https://updates.example.invalid/app.apk', itmsUrl: '' };
beforeEach(() => { vi.clearAllMocks(); mocks.platform.OS = 'android'; mocks.start.mockReturnValue(true); mocks.playInstall.mockReturnValue(false); });

describe('shared bundle install routing', () => {
  it('ordinary updates open the in-app card directly and wait there for the user to confirm', () => {
    promptBundleUpdate({ needsUpdate: true, forced: false, target: { ...target, releaseNotes: '  Faster sync\n' } });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(
      { version: target.version, installUrl: target.installUrl, releaseNotes: 'Faster sync' },
      { confirm: true },
    );
    expect(mocks.openURL).not.toHaveBeenCalled();
  });
  it('the forced gate button is itself the confirmation', () => {
    openBundleInstall(target);
    expect(mocks.start).toHaveBeenCalledWith({ version: target.version, installUrl: target.installUrl }, { confirm: false });
  });
  it('older Android binaries keep the system prompt and its browser download', () => {
    mocks.start.mockReturnValue(false);
    promptBundleUpdate({ needsUpdate: true, forced: false, target });
    const buttons = mocks.alert.mock.calls[0][2];
    buttons[1].onPress();
    expect(mocks.openURL).toHaveBeenCalledWith(target.installUrl);
  });
  it('strong updates retain the blocking gate and never begin installation without a click', () => {
    promptBundleUpdate({ needsUpdate: true, forced: true, target });
    expect(mocks.forced).toHaveBeenCalledWith(target);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
  it('older Android binaries fall back to the existing download URL', () => {
    mocks.start.mockReturnValue(false);
    openBundleInstall(target);
    expect(mocks.openURL).toHaveBeenCalledWith(target.installUrl);
  });
  it('Google Play installs open their store listing without downloading the website APK', async () => {
    mocks.playInstall.mockReturnValue(true);
    openBundleInstall(target);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.openURL).toHaveBeenCalledWith('market://details?id=com.xd.cindy');
  });
  it('Google Play listing falls back to its HTTPS page when the market scheme fails', async () => {
    mocks.playInstall.mockReturnValue(true);
    mocks.openURL.mockRejectedValueOnce(new Error('No market handler'));
    openBundleInstall(target);
    await vi.waitFor(() => expect(mocks.openURL).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=com.xd.cindy'));
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('iOS continues to use its original installation scheme', () => {
    mocks.platform.OS = 'ios';
    openBundleInstall({ ...target, itmsUrl: 'itms-services://?action=download-manifest' });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.openURL).toHaveBeenCalledWith('itms-services://?action=download-manifest');
  });
});
