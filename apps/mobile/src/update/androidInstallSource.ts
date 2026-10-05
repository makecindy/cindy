import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeInstallSource {
  /** Absent on binaries released before the Play routing fix. */
  installerPackageName?: () => string | null;
}

const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeInstallSource>('CindyAppInstaller') : null;

/** Read the installed package's source, rather than a value mutable by JS OTA. */
export function isGooglePlayInstallation(): boolean {
  try {
    return native?.installerPackageName?.() === 'com.android.vending';
  } catch {
    return false;
  }
}
