/**
 * chatEmbeddingStore — 对话语义索引开关的 renderer 镜像。
 *
 * Main 的 owner-scoped settings file 是唯一真值；这里按 dataOwnerId 缓存完整 UI 快照，
 * 仅用于设置页即时渲染。账号切换、Provider 刷新和用户拨动都带 revision fence，旧账号或
 * 旧请求的迟到结果不能覆盖当前 owner。
 */

import { extractIpcError } from '@/utils/ipcError';

const STORAGE_KEY_PREFIX = 'chatEmbedding.settings';

export interface ChatEmbeddingSnapshot {
  enabled: boolean;
  isCustomized: boolean;
  defaultEnabled: boolean;
}

export interface ChatEmbeddingMutationToken {
  dataOwnerId: string | null;
  ownerGeneration: number;
  ownerRevision: number;
  mutationRevision: number;
  previous: ChatEmbeddingSnapshot;
}

type Subscriber = (value: ChatEmbeddingSnapshot) => void;
const subscribers = new Set<Subscriber>();

let activeOwnerId: string | null = null;
let activeOwnerGeneration = 0;
let activeDefaultEnabled = false;
let ownerRevision = 0;
let mutationRevision = 0;
let refreshRevision = 0;
let activeMutationRevision: number | null = null;
let synchronizationDeferredDuringMutation = false;
let inMemorySnapshot: ChatEmbeddingSnapshot = {
  enabled: false,
  isCustomized: false,
  defaultEnabled: false,
};

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function normalizeSnapshot(raw: unknown): ChatEmbeddingSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ChatEmbeddingSnapshot>;
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.isCustomized !== 'boolean' ||
    typeof value.defaultEnabled !== 'boolean'
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    isCustomized: value.isCustomized,
    defaultEnabled: value.defaultEnabled,
  };
}

function readStoredSnapshot(): ChatEmbeddingSnapshot | null {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? normalizeSnapshot(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function publishSnapshot(next: ChatEmbeddingSnapshot, persist = true): void {
  inMemorySnapshot = { ...next };
  if (persist) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(inMemorySnapshot));
    } catch {
      // localStorage is only a cache; Main remains authoritative.
    }
  }
  subscribers.forEach((cb) => cb({ ...inMemorySnapshot }));
}

/** Stable chat-embedding IPC errors to localized settings copy. */
export function chatEmbeddingFailureKey(error: unknown): string {
  return extractIpcError(error)?.code === 'UNSUPPORTED_CAPABILITY'
    ? 'settings.chatEmbedding.toast.unavailable'
    : 'settings.chatEmbedding.toast.toggleFailed';
}

export function getChatEmbeddingSnapshot(): ChatEmbeddingSnapshot {
  return { ...inMemorySnapshot };
}

/**
 * Switch the renderer mirror synchronously at the auth boundary. Returns true when the owner or
 * its account-derived default changed and Main should be refreshed.
 */
export function setChatEmbeddingSettingsOwner(
  ownerId: string | null,
  ownerGeneration: number,
  defaultEnabled: boolean,
): boolean {
  if (
    activeOwnerId === ownerId &&
    activeOwnerGeneration === ownerGeneration &&
    activeDefaultEnabled === defaultEnabled
  ) {
    return false;
  }
  activeOwnerId = ownerId;
  activeOwnerGeneration = ownerGeneration;
  activeDefaultEnabled = defaultEnabled;
  ownerRevision += 1;
  mutationRevision += 1;
  refreshRevision += 1;
  activeMutationRevision = null;
  synchronizationDeferredDuringMutation = false;

  const stored = readStoredSnapshot();
  const next = stored
    ? {
        ...stored,
        enabled:
          !stored.isCustomized && stored.defaultEnabled !== defaultEnabled
            ? defaultEnabled
            : stored.enabled,
        defaultEnabled,
      }
    : {
        enabled: defaultEnabled,
        isCustomized: false,
        defaultEnabled,
      };
  publishSnapshot(next);
  return true;
}

export function subscribeChatEmbeddingSnapshot(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (event: StorageEvent) => {
    if (event.key !== storageKey()) return;
    if (activeMutationRevision !== null) {
      synchronizationDeferredDuringMutation = true;
      return;
    }
    const next = readStoredSnapshot();
    if (!next) return;
    mutationRevision += 1;
    publishSnapshot(next, false);
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

export function beginChatEmbeddingMutation(
  optimisticEnabled?: boolean,
): ChatEmbeddingMutationToken {
  mutationRevision += 1;
  activeMutationRevision = mutationRevision;
  synchronizationDeferredDuringMutation = false;
  const token: ChatEmbeddingMutationToken = {
    dataOwnerId: activeOwnerId,
    ownerGeneration: activeOwnerGeneration,
    ownerRevision,
    mutationRevision,
    previous: getChatEmbeddingSnapshot(),
  };
  if (typeof optimisticEnabled === 'boolean') {
    publishSnapshot({
      ...inMemorySnapshot,
      enabled: optimisticEnabled,
      isCustomized: true,
    });
  }
  return token;
}

function isCurrentMutation(token: ChatEmbeddingMutationToken): boolean {
  return token.ownerRevision === ownerRevision && token.mutationRevision === activeMutationRevision;
}

export function completeChatEmbeddingMutation(
  token: ChatEmbeddingMutationToken,
  settings: ChatEmbeddingSnapshot,
): boolean {
  if (!isCurrentMutation(token)) return false;
  const shouldRefresh = synchronizationDeferredDuringMutation;
  activeMutationRevision = null;
  synchronizationDeferredDuringMutation = false;
  mutationRevision += 1;
  publishSnapshot(settings);
  if (shouldRefresh) void refreshChatEmbeddingFromMain();
  return true;
}

export function rollbackChatEmbeddingMutation(token: ChatEmbeddingMutationToken): boolean {
  if (!isCurrentMutation(token)) return false;
  const shouldRefresh = synchronizationDeferredDuringMutation;
  activeMutationRevision = null;
  synchronizationDeferredDuringMutation = false;
  mutationRevision += 1;
  publishSnapshot(token.previous);
  if (shouldRefresh) void refreshChatEmbeddingFromMain();
  return true;
}

/** Load the current Main truth and drop stale owner/provider/mutation responses. */
export async function refreshChatEmbeddingFromMain(): Promise<void> {
  const requestOwnerRevision = ownerRevision;
  const requestMutationRevision = mutationRevision;
  const requestRevision = ++refreshRevision;
  try {
    const settings = await window.electronAPI.maker.chatEmbeddingGet();
    if (requestOwnerRevision !== ownerRevision || requestRevision !== refreshRevision) {
      return;
    }
    if (activeMutationRevision !== null) {
      synchronizationDeferredDuringMutation = true;
      return;
    }
    if (requestMutationRevision !== mutationRevision) {
      void refreshChatEmbeddingFromMain();
      return;
    }
    publishSnapshot({
      enabled: settings.enabled,
      isCustomized: Boolean(settings.isCustomized),
      defaultEnabled: Boolean(settings.defaultEnabled),
    });
  } catch {
    // Main may still be starting. Auth/provider changes and component mount retry.
  }
}

export async function bootstrapChatEmbeddingFromMain(): Promise<void> {
  await refreshChatEmbeddingFromMain();
}

export const __testing = {
  normalizeSnapshot,
};
