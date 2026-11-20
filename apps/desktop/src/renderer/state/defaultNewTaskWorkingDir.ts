import { useSyncExternalStore } from 'react';
import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';

const STORAGE_KEY = 'xdt:defaultNewTaskWorkingDir:v1';
const CHANGE_EVENT = 'cindy:default-new-task-working-dir-changed';

function keyForOwner(ownerId: string): string {
  return `${STORAGE_KEY}:${encodeURIComponent(ownerId)}`;
}

function normalizeDefaultDir(path: string | null | undefined): string | null {
  const normalized = normalizeWorkingDirForStorage(path);
  return normalized ? (getManagedWorktreeBasePath(normalized) ?? normalized) : null;
}

/** This preference is local to this computer and isolated by data owner. */
export function getDefaultNewTaskWorkingDir(ownerId: string | null): string | null {
  if (!ownerId) return null;
  try {
    const value = normalizeDefaultDir(localStorage.getItem(keyForOwner(ownerId)));
    // Only absolute paths selected on this computer can become a task target.
    return value && (/^\//.test(value) || /^[A-Za-z]:\//.test(value)) ? value : null;
  } catch {
    return null;
  }
}

export function setDefaultNewTaskWorkingDir(ownerId: string, path: string | null): void {
  const normalized = normalizeDefaultDir(path);
  if (normalized && !(/^\//.test(normalized) || /^[A-Za-z]:\//.test(normalized))) {
    throw new Error('Default working directory must be absolute');
  }
  const key = keyForOwner(ownerId);
  if (normalized) localStorage.setItem(key, normalized);
  else localStorage.removeItem(key);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: ownerId }));
}

export function useDefaultNewTaskWorkingDir(ownerId: string | null): string | null {
  return useSyncExternalStore(
    (notify) => {
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === ownerId) notify();
      };
      const onStorageChange = (event: StorageEvent) => {
        if (ownerId && (event.key === keyForOwner(ownerId) || event.key === null)) notify();
      };
      window.addEventListener(CHANGE_EVENT, onLocalChange);
      window.addEventListener('storage', onStorageChange);
      return () => {
        window.removeEventListener(CHANGE_EVENT, onLocalChange);
        window.removeEventListener('storage', onStorageChange);
      };
    },
    () => getDefaultNewTaskWorkingDir(ownerId),
    () => null,
  );
}
