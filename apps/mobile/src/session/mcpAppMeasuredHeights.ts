import AsyncStorage from '@react-native-async-storage/async-storage';
import { McpAppMeasuredHeights } from '@cindy/maker-shared/mcp-app-controller';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

const listeners = new Set<() => void>();
export const subscribeMobileHeights = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
let current: McpAppMeasuredHeights | null = null;
export const getMobileHeights = () => current;
let writing: Promise<void> = Promise.resolve();

function activate() {
  const owner = getMobileAuthOwner();
  current?.dispose();
  current = null;
  for (const notify of listeners) notify();
  const key = owner.accountKey && `cindy.mobile.mcpAppHeights.v1.${owner.accountKey}`;
  // A switch back to this account must see its last already-issued write.
  void writing.then(async () => {
    if (owner !== getMobileAuthOwner()) return;
    let stored: string | null = null;
    try { if (key) stored = await AsyncStorage.getItem(key); } catch { /* Start with an empty cache. */ }
    if (owner !== getMobileAuthOwner()) return;
    current = new McpAppMeasuredHeights(stored, snapshot => {
      if (!key || owner !== getMobileAuthOwner()) return;
      writing = AsyncStorage.setItem(key, JSON.stringify(snapshot)).catch(() => {});
      return writing;
    });
    for (const notify of listeners) notify();
  });
}
subscribeMobileAuthOwner(activate);
activate();
