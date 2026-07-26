const iosSyncBannerMask = { left: 235, top: 440, width: 520, height: 100 };

const profiles = {
  'ios-iphone-17-pro-native': {
    platform: 'ios',
    appId: 'com.xd.cindy',
    visualProfile: 'ios-iphone-17-pro-native',
    visualIgnoreTopPx: 120,
  },
  'ios-iphone-17-pro-expo-go': {
    platform: 'ios',
    appId: 'host.exp.Exponent',
    expoUrl: 'exp://localhost:8081/--/devices',
    visualProfile: 'ios-iphone-17-pro-expo-go',
    visualIgnoreTopPx: 120,
    visualPixelTolerance: 8,
    visualMasks: {
      'visual-devices': [
        { left: 90, top: 440, width: 390, height: 100 },
      ],
      'visual-device-detail': [
        iosSyncBannerMask,
      ],
      'visual-device-detail-filters': [
        iosSyncBannerMask,
      ],
      'visual-device-detail-automation-group': [
        iosSyncBannerMask,
      ],
      'visual-device-detail-selection': [
        iosSyncBannerMask,
      ],
      'visual-session': [
        iosSyncBannerMask,
      ],
      'visual-session-controls': [
        iosSyncBannerMask,
      ],
      'visual-session-controls-session': [
        iosSyncBannerMask,
      ],
      'visual-session-controls-usage': [
        iosSyncBannerMask,
      ],
      'visual-session-idle': [
        iosSyncBannerMask,
      ],
      'visual-session-running': [
        iosSyncBannerMask,
      ],
      'visual-session-pending': [
        iosSyncBannerMask,
      ],
      'visual-session-permission': [
        iosSyncBannerMask,
      ],
      'visual-session-ask': [
        iosSyncBannerMask,
      ],
      'visual-session-queue': [
        iosSyncBannerMask,
      ],
      'visual-files': [
        iosSyncBannerMask,
      ],
      'visual-files-preview': [
        iosSyncBannerMask,
      ],
      'visual-automations': [
        iosSyncBannerMask,
      ],
      'visual-automations-form': [
        iosSyncBannerMask,
      ],
    },
  },
  'android-pixel-expo-go': {
    platform: 'android',
    appId: 'host.exp.exponent',
    expoUrl: 'exp://10.0.2.2:8081/--/devices',
    visualProfile: 'android-pixel-expo-go',
    visualIgnoreTopPx: 0,
  },
};

export function resolveMobileE2eProfile(name, options = {}) {
  if (!name) return null;
  const profile = profiles[name];
  if (!profile && options.allowUnknown) return null;
  if (!profile) {
    throw new Error(`Unknown mobile E2E profile: ${name}. Known profiles: ${Object.keys(profiles).join(', ')}`);
  }
  return { name, ...profile };
}

export function knownMobileE2eProfiles() {
  return Object.keys(profiles);
}
