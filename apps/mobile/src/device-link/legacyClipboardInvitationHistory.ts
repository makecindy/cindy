import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'cindy.mobile.shared-task.clipboard-history.v1.';

/** Clipboard invitation detection was removed; erase its per-account digests left on disk. */
export async function removeLegacyClipboardInvitationHistory(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // Best effort; the next launch retries.
  }
}
