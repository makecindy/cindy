import { useSyncExternalStore } from 'react';

export type ChatLayoutMode = 'standard' | 'wide';

export const CHAT_WIDTH_PERCENT = { min: 25, max: 100, step: 5, defaultValue: 75 } as const;

const MODE_KEY = 'chat.layoutMode';
const WIDTH_KEY = 'chat.layoutWidthPercent';
const CHANGE_EVENT = 'cindy-chat-layout-changed';

let fallbackMode: string | null | undefined;
let fallbackWidth: string | null | undefined;
let previewWidth: number | null = null;

function read(key: string, fallback: string | null | undefined): string | null {
  if (fallback !== undefined) return fallback;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): string | null | undefined {
  try {
    const storage = window.localStorage;
    if (storage.getItem(key) !== value) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
    return undefined;
  } catch {
    // The selection still applies to the current renderer if storage is unavailable.
    return value;
  }
}

function subscribe(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === MODE_KEY) fallbackMode = undefined;
    if (event.key === null || event.key === WIDTH_KEY) fallbackWidth = undefined;
    if (event.key === null || event.key === MODE_KEY || event.key === WIDTH_KEY) notify();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, notify);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, notify);
  };
}

function notifyChange(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function getMode(): ChatLayoutMode {
  return read(MODE_KEY, fallbackMode) === 'wide' ? 'wide' : 'standard';
}

function isWidthPercent(value: number): boolean {
  const { min, max, step } = CHAT_WIDTH_PERCENT;
  return value >= min && value <= max && (value - min) % step === 0;
}

function getSavedWidth(): number {
  const value = Number(read(WIDTH_KEY, fallbackWidth));
  return isWidthPercent(value) ? value : CHAT_WIDTH_PERCENT.defaultValue;
}

function getWidth(): number {
  return previewWidth ?? getSavedWidth();
}

function getWideWidth(): number | null {
  return getMode() === 'wide' ? getWidth() : null;
}

export function useWideChatWidth(): number | null {
  return useSyncExternalStore(subscribe, getWideWidth);
}

function setMode(mode: ChatLayoutMode): void {
  fallbackMode = write(MODE_KEY, mode === 'wide' ? 'wide' : null);
  previewWidth = null;
  notifyChange();
}

function setWidth(value: number): void {
  if (!isWidthPercent(value)) return;
  fallbackWidth = write(WIDTH_KEY, value === CHAT_WIDTH_PERCENT.defaultValue ? null : String(value));
  previewWidth = null;
  notifyChange();
}

function preview(value: number | null): void {
  const next = value !== null && isWidthPercent(value) && value !== getSavedWidth() ? value : null;
  if (next === previewWidth) return;
  previewWidth = next;
  notifyChange();
}

export function useChatLayoutPreference() {
  const mode = useSyncExternalStore(subscribe, getMode);
  const width = useSyncExternalStore(subscribe, getWidth);
  return { mode, width, setMode, setWidth, preview };
}
