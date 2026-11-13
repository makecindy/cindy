import { requireOptionalNativeModule } from 'expo-modules-core';
import Notifications from './nativeNotifications';
import { readIosPushEnvironment } from './nativePushEnvironment';

/** expo-notifications IosAuthorizationStatus.PROVISIONAL; the SDK enum stays behind the adapter. */
const IOS_STATUS_PROVISIONAL = 3;

export interface PushDiagnostic {
  bundleId: string;
  build: string;
  environment: 'development' | 'production';
  permission: string;
  alerts: boolean | null;
  lockScreen: boolean | null;
  notificationCenter: boolean | null;
  token: string | null;
}

/** Explicit local inspection only. Never persist, log, upload or request permission.
 * Reading APNs may emit the normal token event; the registration bridge deduplicates it. */
export async function readIosPushDiagnostic(isCurrent: () => boolean): Promise<PushDiagnostic | null> {
  if (!isCurrent()) return null;
  const application = requireOptionalNativeModule<{ applicationId?: string; nativeBuildVersion?: string }>('ExpoApplication');
  const permission = await Notifications.getPermissionsAsync();
  if (!isCurrent()) return null;
  const environment = await readIosPushEnvironment();
  if (!isCurrent()) return null;
  if (environment !== 'development' && environment !== 'production') throw new Error('PUSH_DIAGNOSTIC_ENVIRONMENT_UNKNOWN');
  const diagnostic: PushDiagnostic = {
    bundleId: application?.applicationId ?? '—',
    build: application?.nativeBuildVersion ?? '—',
    environment,
    permission: permission.ios?.status === IOS_STATUS_PROVISIONAL
      ? 'provisional' : permission.status,
    alerts: permission.ios?.allowsAlert ?? null,
    lockScreen: permission.ios?.allowsDisplayOnLockScreen ?? null,
    notificationCenter: permission.ios?.allowsDisplayInNotificationCenter ?? null,
    token: null,
  };
  // A diagnostic must not open system permission prompts or enable notifications.
  if (permission.status !== 'granted') return diagnostic;
  const token = await Notifications.getDevicePushTokenAsync();
  if (!isCurrent()) return null;
  if (token.type !== 'ios' || typeof token.data !== 'string' || !/^[a-fA-F0-9]+$/.test(token.data) || token.data.length > 512) {
    throw new Error('PUSH_DIAGNOSTIC_TOKEN_INVALID');
  }
  return { ...diagnostic, token: token.data };
}
