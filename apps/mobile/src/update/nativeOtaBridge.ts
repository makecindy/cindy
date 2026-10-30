import { requireOptionalNativeModule } from 'expo-modules-core';
import type { NativeOtaBridge } from './nativeOtaRequestCoordinator';

/** Capability comes from the installed native binary, not the downloaded manifest. */
export function getNativeOtaBridge(): NativeOtaBridge | null {
  const module = requireOptionalNativeModule<Partial<NativeOtaBridge>>('ExpoUpdates');
  if (typeof module?.cindySelfHostOtaCapabilities !== 'function') return null;
  if (typeof module.cindyBeginSelfHostOtaRequest !== 'function' ||
    typeof module.cindyFinishSelfHostOtaRequest !== 'function') {
    throw new Error('incomplete-native-ota-contract');
  }
  return module as NativeOtaBridge;
}
