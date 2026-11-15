/**
 * 「显示回复对应的消息」本机偏好（docs/product-rules/cindy-bots-runtime.md「回复对应的消息」）：打开后
 * 伙伴回复上方标出它回的是主人哪一条消息，对所有伙伴生效。默认关；只存 override（开时写入，关回默认即删除），
 * 与 Desktop 的本机偏好各自独立。
 */
import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const key = 'cindy.mobile.companion-reply-target.v1';
let current = false;
let loaded: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function load() {
  if (!loaded) {
    const initialRevision = revision;
    loaded = AsyncStorage.getItem(key).then(raw => {
      if (initialRevision === revision) {
        current = raw === 'true';
        notify();
      }
    }).catch(() => undefined);
  }
  return loaded;
}

export function saveCompanionReplyTargetPreference(enabled: boolean): Promise<void> {
  revision += 1;
  current = enabled;
  notify();
  const write = writes.catch(() => undefined)
    .then(() => (enabled ? AsyncStorage.setItem(key, 'true') : AsyncStorage.removeItem(key)));
  writes = write;
  return write;
}

export function useCompanionReplyTargetPreference(): boolean {
  const enabled = useSyncExternalStore(subscribe, () => current, () => false);
  useEffect(() => { void load(); }, []);
  return enabled;
}
