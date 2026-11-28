import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { getActiveSelfHostedRelay, isAgentNetOnlyRoute } from './selfHostedRelayRouting';

const KEY = 'cindy.mobile.agent-net.preferences.v1';
/**
 * `removed`: the switch was turned off because the official service said this phone was removed from the account
 * (agentNetRuntime.ts, 2026-11-26: a removed device turns Agent-Net off, and turning it on again rejoins). Shown under the
 * switch until the person changes it; stored only while true, so older app versions read the same record.
 */
interface Preferences { ready: boolean; enabled: boolean; onlyEncrypted: boolean; removed: boolean; generation: number; }
let current: Preferences = { ready: false, enabled: false, onlyEncrypted: false, removed: false, generation: 0 };
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
    const entry = value as { version?: unknown; enabled?: unknown; onlyEncrypted?: unknown; removed?: unknown } | null;
    if (!entry || entry.version !== 1 || typeof entry.enabled !== 'boolean' || typeof entry.onlyEncrypted !== 'boolean') {
      throw new Error('AGENT_NET_PREFERENCES_UNREADABLE');
    }
    publish({ ready: true, enabled: entry.enabled, onlyEncrypted: entry.onlyEncrypted, removed: entry.removed === true && !entry.enabled });
  })().finally(() => { loading = null; });
  return loading;
}
/** A change by the person clears `removed`; only the removal itself (agentNetRuntime.ts) sets it, with the switch off. */
export function setMobileAgentNetPreferences(patch: Partial<Pick<Preferences, 'enabled' | 'onlyEncrypted' | 'removed'>>): Promise<void> {
  const work = writing.then(async () => {
    await waitForMobileAgentNetPreferences();
    const previous = current;
    const enabled = patch.enabled ?? previous.enabled;
    const next = { ready: true, enabled, onlyEncrypted: patch.onlyEncrypted ?? previous.onlyEncrypted, removed: patch.removed === true && !enabled };
    // Apply the privacy fence synchronously before the persistence await.
    publish(next);
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify({ version: 1, enabled: next.enabled, onlyEncrypted: next.onlyEncrypted,
        ...(next.removed ? { removed: true } : {}) }));
    } catch (error) {
      publish({ ready: previous.ready, enabled: previous.enabled, onlyEncrypted: previous.onlyEncrypted, removed: previous.removed });
      throw error;
    }
  });
  writing = work.then(() => undefined, () => undefined);
  return work;
}
export function useMobileAgentNetPreferences(): Readonly<Preferences> {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getMobileAgentNetPreferences);
}
