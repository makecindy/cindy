import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import { QuotaWidgetController } from './quotaWidgetController';

interface NativeQuotaWidget {
  writeSnapshot(json: string): void;
  clearSnapshot(): void;
  setPresentation(locale: string, appearance: string): void;
}
export const nativeQuotaWidget = requireOptionalNativeModule<NativeQuotaWidget>('CindyQuotaWidget');
export const quotaWidgetStore = new QuotaWidgetController(AsyncStorage, nativeQuotaWidget ?? {
  writeSnapshot: () => undefined,
  clearSnapshot: () => undefined,
}, id => revokedDevicesStore.has(id));
// Auth publishes synchronously before React commits or async cleanup. Every loss/switch clears the extension first.
subscribeMobileAuthOwner(() => { void quotaWidgetStore.setOwner(getMobileAuthOwner().accountKey); });
void quotaWidgetStore.setOwner(getMobileAuthOwner().accountKey);
revokedDevicesStore.subscribe(() => {
  const deviceId = quotaWidgetStore.getSnapshot().deviceId;
  if (deviceId && revokedDevicesStore.has(deviceId)) void quotaWidgetStore.selectDevice(null);
});
