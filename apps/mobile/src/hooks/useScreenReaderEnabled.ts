/**
 * 系统读屏（VoiceOver / TalkBack）是否开启。模块级单一订阅，消息列表等高频组件读同一份值，
 * 不按行各自查询。查询前按 false 处理：读屏用户的首帧可能先看到长按入口，结果到达后立即切换。
 */
import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

let enabled = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const update = (next: boolean) => {
  if (next === enabled) return;
  enabled = next;
  notify();
};

// Hosts without the API (web, test stubs) keep the default.
if (typeof AccessibilityInfo?.isScreenReaderEnabled === 'function') {
  void AccessibilityInfo.isScreenReaderEnabled().then(update, () => undefined);
  AccessibilityInfo.addEventListener('screenReaderChanged', update);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useScreenReaderEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}
