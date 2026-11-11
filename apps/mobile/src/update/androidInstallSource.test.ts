import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  installerPackageName: vi.fn<() => string | null>(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({ installerPackageName: mocks.installerPackageName }),
}));

import { isGooglePlayInstallation } from './androidInstallSource';

beforeEach(() => {
  mocks.installerPackageName.mockReset();
});

describe('Android install source', () => {
  it('recognizes Google Play as the installer', () => {
    mocks.installerPackageName.mockReturnValue('com.android.vending');
    expect(isGooglePlayInstallation()).toBe(true);
  });

  it.each([null, 'com.google.android.packageinstaller', 'com.android.packageinstaller'])
    ('keeps APK distribution for installer %s', (installer) => {
      mocks.installerPackageName.mockReturnValue(installer);
      expect(isGooglePlayInstallation()).toBe(false);
    });

  it('keeps old binaries without the new native query usable', () => {
    mocks.installerPackageName.mockImplementation(() => { throw new Error('Unavailable'); });
    expect(isGooglePlayInstallation()).toBe(false);
  });
});
