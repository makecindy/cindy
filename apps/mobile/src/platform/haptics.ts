import { requireOptionalNativeModule } from 'expo-modules-core';

export type HapticKind = 'selection' | 'commit';

/** Optional enhancement: native hardware/policy gates run on every interaction.
 * Older builds and web stay silent; haptic failures must never interrupt an action.
 */
export function playHaptic(kind: HapticKind): void {
  try {
    const native = requireOptionalNativeModule<{ play(kind: HapticKind): Promise<boolean> }>('CindyHaptics');
    void native?.play(kind).catch(() => {});
  } catch {
    // An unavailable native bridge is equivalent to unsupported hardware.
  }
}
