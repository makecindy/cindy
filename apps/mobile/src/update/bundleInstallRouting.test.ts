import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  alert: vi.fn(),
  openURL: vi.fn(async () => undefined),
  start: vi.fn(() => true),
  forced: vi.fn(),
}));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert }, Linking: { openURL: mocks.openURL }, Platform: mocks.platform }));
vi.mock('expo-updates', () => ({}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/config/env', () => ({ APP_BINARY_VERSION: '1.0.0', IS_OTA_SELFHOST: true, IS_TESTFLIGHT_BUILD: false, REVIEW_MODE: false }));
vi.mock('./androidInstaller', () => ({ androidInstaller: { start: mocks.start } }));
vi.mock('./forcedUpdateStore', () => ({ enterForcedUpdate: mocks.forced }));
vi.mock('./canaryChannelStore', () => ({ resolveUpdateChannelForDevice: () => 'release' }));
import { openBundleInstall, promptBundleUpdate } from './useBundleUpdatePrompt';
const target = { version: '1.2.3', runtimeVersion: 'new', installUrl: 'https://updates.example.invalid/app.apk', itmsUrl: '' };
beforeEach(() => { vi.clearAllMocks(); mocks.platform.OS = 'android'; mocks.start.mockReturnValue(true); });

describe('shared bundle install routing', () => {
  it('ordinary update confirmation starts the same native path as the forced gate', () => {
    promptBundleUpdate({ needsUpdate: true, forced: false, target });
    expect(mocks.start).not.toHaveBeenCalled();
    const buttons = mocks.alert.mock.calls[0][2];
    buttons[1].onPress();
    expect(mocks.start).toHaveBeenCalledWith({ version: target.version, installUrl: target.installUrl });
    expect(mocks.openURL).not.toHaveBeenCalled();
    openBundleInstall(target);
    expect(mocks.start).toHaveBeenCalledTimes(2);
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
  it('iOS continues to use its original installation scheme', () => {
    mocks.platform.OS = 'ios';
    openBundleInstall({ ...target, itmsUrl: 'itms-services://?action=download-manifest' });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.openURL).toHaveBeenCalledWith('itms-services://?action=download-manifest');
  });
});
