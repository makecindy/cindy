import type { ToastItem } from './toast';

export type FileTransferToast = ToastItem & { name: string };

// Transfers share one notification, independent of the ordinary toast queue's limit.
let items: readonly FileTransferToast[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly FileTransferToast[]) {
  items = next;
  for (const listener of listeners) listener();
}

export const getFileTransferToasts = () => items;
export function subscribeFileTransferToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addFileTransferToast(item: FileTransferToast) {
  publish([...items, item]);
}

export function updateFileTransferToast(id: string, message: string) {
  if (!items.some((item) => item.id === id && item.message !== message)) return;
  publish(items.map((item) => (item.id === id ? { ...item, message } : item)));
}

export function removeFileTransferToast(id: string) {
  if (items.some((item) => item.id === id)) publish(items.filter((item) => item.id !== id));
}
