import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{ residentHistoryAvailable?: boolean; sharedTaskDrawerAvailable?: boolean; taskDrawerHandoffAvailable?: boolean }>('XdtIosActionSheet') : null;
// An older installed iOS binary must retain normal navigation, never use a
// root overlay that intercepts the native interactive-pop gesture.
export const needsResidentHistoryUpgrade = Platform.OS === 'ios' && !native?.residentHistoryAvailable;
export const NativeHistoryHost = native?.residentHistoryAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string }>('XdtIosActionSheet', 'ResidentHistoryHost') : null;
export const NativeHistorySlot = native?.residentHistoryAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string; selected: boolean; onDock?: () => void }>('XdtIosActionSheet', 'ResidentHistorySlot') : null;

// Older binaries can retain a floating list, but cannot move its SwiftUI
// controllers between a Modal and a screen safely.
export const NativeTaskDrawerHost = native?.sharedTaskDrawerAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string }>('XdtIosActionSheet', 'TaskDrawerHost') : null;

/** Native acknowledgment after the live list has reached its new window. */
export const taskDrawerHandoffAvailable = native?.taskDrawerHandoffAvailable === true;
