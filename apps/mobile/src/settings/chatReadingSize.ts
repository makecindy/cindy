import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

export const CHAT_READING_SIZES = ['default', 'smaller'] as const;
export type ChatReadingSize = typeof CHAT_READING_SIZES[number];

const storageKey = 'cindy.mobile.chat-reading-size.v1';
const listeners = new Set<() => void>();
const defaultSize = () => 'default' as const;
let size: ChatReadingSize = 'default';
let loading: Promise<void> | undefined;
let writes = Promise.resolve();

/** Only the ordinary Android conversation history provides this value. */
export const ChatReadingSizeContext = createContext<ChatReadingSize>('default');

function publish(next: ChatReadingSize) {
  if (size === next) return;
  size = next;
  listeners.forEach(listener => listener());
}

function load() {
  loading ??= AsyncStorage.getItem(storageKey).then(
    stored => publish(stored === 'smaller' ? 'smaller' : 'default'),
    () => undefined,
  );
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatReadingSize(enabled = true): ChatReadingSize {
  const active = enabled && Platform.OS === 'android';
  const preference = useSyncExternalStore(subscribe, active ? () => size : defaultSize, defaultSize);
  useEffect(() => {
    if (active) void load();
  }, [active]);
  return preference;
}

export function saveChatReadingSize(next: ChatReadingSize): Promise<void> {
  const write = writes.catch(() => undefined).then(async () => {
    await load();
    if (next === 'default') await AsyncStorage.removeItem(storageKey);
    else await AsyncStorage.setItem(storageKey, next);
    publish(next);
  });
  writes = write;
  return write;
}
