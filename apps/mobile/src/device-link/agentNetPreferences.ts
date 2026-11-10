import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { getActiveSelfHostedRelay, isAgentNetOnlyRoute } from './selfHostedRelayRouting';

const KEY = 'cindy.mobile.agent-net.preferences.v1';
interface Preferences { ready: boolean; enabled: boolean; onlyEncrypted: boolean; generation: number; }
let current: Preferences = { ready: false, enabled: false, onlyEncrypted: false, generation: 0 };
let loading: Promise<void> | null = null, writing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
function publish(value: Omit<Preferences, 'generation'>) {
  current = { ...value, generation: current.generation + 1 };
  for (const listener of listeners) listener();
}
export const getMobileAgentNetPreferences = (): Readonly<Preferences> => current;
export function subscribeMobileAgentNetPreferences(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function mobileAgentNetRequiresEncryption(): boolean {
  // 只走 V2 的网络(别人分享来的中转)没有旧版连接。
  return !current.ready || (current.enabled && current.onlyEncrypted) || isAgentNetOnlyRoute(getActiveSelfHostedRelay());
}
export function mobileAgentNetAllowsLegacy(): boolean { return current.ready && !mobileAgentNetRequiresEncryption(); }
export function waitForMobileAgentNetPreferences(): Promise<void> {
  if (current.ready) return Promise.resolve();
  if (!loading) loading = (async () => {
    const raw = await AsyncStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : { version: 1, enabled: false, onlyEncrypted: false };
    const entry = value as { version?: unknown; enabled?: unknown; onlyEncrypted?: unknown } | null;
    if (!entry || entry.version !== 1 || typeof entry.enabled !== 'boolean' || typeof entry.onlyEncrypted !== 'boolean') {
      throw new Error('AGENT_NET_PREFERENCES_UNREADABLE');
    }
    publish({ ready: true, enabled: entry.enabled, onlyEncrypted: entry.onlyEncrypted });
  })().finally(() => { loading = null; });
  return loading;
}
export function setMobileAgentNetPreferences(patch: Partial<Pick<Preferences, 'enabled' | 'onlyEncrypted'>>): Promise<void> {
  const work = writing.then(async () => {
    await waitForMobileAgentNetPreferences();
    const previous = current;
    const next = { ready: true, enabled: patch.enabled ?? previous.enabled, onlyEncrypted: patch.onlyEncrypted ?? previous.onlyEncrypted };
    // Apply the privacy fence synchronously before the persistence await.
    publish(next);
    try { await AsyncStorage.setItem(KEY, JSON.stringify({ version: 1, enabled: next.enabled, onlyEncrypted: next.onlyEncrypted })); }
    catch (error) {
      publish({ ready: previous.ready, enabled: previous.enabled, onlyEncrypted: previous.onlyEncrypted });
      throw error;
    }
  });
  writing = work.then(() => undefined, () => undefined);
  return work;
}
export function useMobileAgentNetPreferences(): Readonly<Preferences> {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getMobileAgentNetPreferences);
}
