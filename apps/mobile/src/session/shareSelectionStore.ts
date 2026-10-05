import { useSyncExternalStore } from "react";

interface ShareableMessageLike {
  kind: string;
  systemCardType?: unknown;
  orcaCard?: unknown;
  hookSource?: { userTextContent?: boolean };
  isSyntheticTrigger?: boolean;
}

/**
 * 旧 Hook 行落库的是拼好的 Agent prompt，不进分享；本机 IM 行落库的是用户原文，
 * 与普通用户消息一样可分享（分享图不带任何来源标签）。
 */
export function isShareableMessage(message: ShareableMessageLike): boolean {
  return (
    (message.kind === "user" || message.kind === "assistant") &&
    !message.systemCardType &&
    !message.orcaCard &&
    (!message.hookSource || message.hookSource.userTextContent === true) &&
    message.isSyntheticTrigger !== true
  );
}

let activeSessionId: string | null = null;
const selectedIds = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const shareSelectionStore = {
  subscribe,
  getActiveSessionId(): string | null {
    return activeSessionId;
  },
  isActive(sessionId: string | undefined): boolean {
    return Boolean(sessionId) && activeSessionId === sessionId;
  },
  isSelected(clientId: string | undefined): boolean {
    return Boolean(clientId && selectedIds.has(clientId));
  },
  count(): number {
    return selectedIds.size;
  },
  /** 全选临时覆盖前保存当前勾选集合，取消全选时原样恢复。 */
  getSelectedIds(): string[] {
    return Array.from(selectedIds);
  },
  enter(sessionId: string, preselectedClientId?: string): void {
    if (!sessionId) return;
    if (activeSessionId !== sessionId) selectedIds.clear();
    activeSessionId = sessionId;
    if (preselectedClientId) selectedIds.add(preselectedClientId);
    notify();
  },
  exit(): void {
    if (activeSessionId === null && selectedIds.size === 0) return;
    activeSessionId = null;
    selectedIds.clear();
    notify();
  },
  toggle(clientId: string): void {
    if (!clientId) return;
    if (selectedIds.has(clientId)) selectedIds.delete(clientId);
    else selectedIds.add(clientId);
    notify();
  },
  setSelection(clientIds: readonly string[]): void {
    selectedIds.clear();
    for (const clientId of clientIds) {
      if (clientId) selectedIds.add(clientId);
    }
    notify();
  },
  getSelectedIdsInOrder(orderedIds: readonly string[]): string[] {
    return orderedIds.filter((clientId) => selectedIds.has(clientId));
  },
  exitIfNotSession(sessionId: string | undefined): void {
    if (activeSessionId !== null && activeSessionId !== sessionId)
      shareSelectionStore.exit();
  },
};

export function useShareSelectionActive(
  sessionId: string | undefined,
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.isActive(sessionId),
    () => false,
  );
}

export function useIsMessageSelected(clientId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.isSelected(clientId),
    () => false,
  );
}

export function useShareSelectionCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => shareSelectionStore.count(),
    () => 0,
  );
}

export function useShareSelectionRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
}
