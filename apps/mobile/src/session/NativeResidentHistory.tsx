import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{ residentHistoryAvailable?: boolean }>('XdtIosActionSheet') : null;
// An older installed iOS binary must retain normal navigation, never use a
// root overlay that intercepts the native interactive-pop gesture.
export const needsResidentHistoryUpgrade = Platform.OS === 'ios' && !native?.residentHistoryAvailable;
export const NativeHistoryHost = native?.residentHistoryAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string }>('XdtIosActionSheet', 'ResidentHistoryHost') : null;
export const NativeHistorySlot = native?.residentHistoryAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string; selected: boolean }>('XdtIosActionSheet', 'ResidentHistorySlot') : null;
