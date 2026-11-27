import { requireOptionalNativeModule } from 'expo-modules-core';

/** ExpoApplication is already bundled by expo-notifications. Read its signed
 * provisioning environment; JS development mode does not describe APNs signing. */
export async function readIosPushEnvironment(): Promise<string | null> {
  const native = requireOptionalNativeModule<{
    getPushNotificationServiceEnvironmentAsync(): Promise<string | null>;
    getApplicationReleaseTypeAsync?(): Promise<number>;
  }>('ExpoApplication');
  if (typeof native?.getPushNotificationServiceEnvironmentAsync !== 'function') {
    throw new Error('The installed app cannot read its APNs signing environment');
  }
  const environment = await native.getPushNotificationServiceEnvironmentAsync();
  // App Store re-signing may remove embedded.mobileprovision. Expo's native
  // APP_STORE release type is 5; simulator/unknown/development never take this path.
  if (environment === null && await native.getApplicationReleaseTypeAsync?.() === 5) return 'production';
  return environment;
}
