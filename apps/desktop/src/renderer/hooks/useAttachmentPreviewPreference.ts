import { useSyncExternalStore } from 'react';

export type AttachmentPreviewPreference = 'popup' | 'sidebar';

const storageKey = 'chat.attachmentPreviewPreference';
const changeEvent = 'cindy-attachment-preview-preference-changed';
let fallback: AttachmentPreviewPreference | undefined;

export function getAttachmentPreviewPreference(): AttachmentPreviewPreference {
  if (fallback) return fallback;
  try {
    return window.localStorage.getItem(storageKey) === 'sidebar' ? 'sidebar' : 'popup';
  } catch {
    return 'popup';
  }
}

export function setAttachmentPreviewPreference(preference: AttachmentPreviewPreference): void {
  try {
    if (preference === 'popup') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, preference);
    fallback = undefined;
  } catch {
    fallback = preference;
  }
  window.dispatchEvent(new Event(changeEvent));
}

function subscribe(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      fallback = undefined;
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(changeEvent, notify);
  };
}

export function useAttachmentPreviewPreference(): AttachmentPreviewPreference {
  return useSyncExternalStore(subscribe, getAttachmentPreviewPreference);
}
