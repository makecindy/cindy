import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';

export type PendingSideChatStatus = 'creating' | 'ready' | 'failed' | 'cancelled';

export interface PendingSideChatRecord {
  tabId: string;
  /** Stable draft key kept across pending -> ready so ChatInput never resets mid-typing. */
  draftKey: string;
  parentSessionId: string;
  deviceId: string | null;
  previewSession: Session;
  status: PendingSideChatStatus;
  childSession: Session | null;
  errorMessage?: string;
  hasTransferredAttachments: boolean;
  hasQueuedSend: boolean;
  onRetry?: () => void;
  ownerGeneration: DataOwnerGeneration;
}

type Listener = () => void;

const records = new Map<string, PendingSideChatRecord>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function createPendingSideChatDraftKey(): string {
  return `side-chat-pending:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Derive an optimistic side-chat snapshot from the parent task so the embedded
 * composer renders with the parent's model, effort, permission mode, and working
 * directory immediately while the host finishes forking.
 */
export function buildPreviewSideChatSession(
  parentSessionId: string,
  parentSession: Session | null | undefined,
  draftKey: string,
  deviceId: string | null,
): Session {
  const nowIso = new Date().toISOString();
  return {
    id: draftKey,
    userId: parentSession?.userId ?? '',
    title: parentSession?.title ?? '',
    workingDir: parentSession?.workingDir ?? '',
    model: parentSession?.model ?? '',
    providerId: parentSession?.providerId ?? null,
    effort: parentSession?.effort ?? 'medium',
    permissionMode: parentSession?.permissionMode ?? 'default',
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: parentSession?.contextWindow ?? 0,
    fastMode: parentSession?.fastMode ?? false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: nowIso,
    agentKind: parentSession?.agentKind ?? 'cc',
    workspaceKind: parentSession?.workspaceKind ?? 'project',
    source: 'side-chat',
    parentSessionId,
    extraDirs: parentSession?.extraDirs ?? [],
    writableDirs: parentSession?.writableDirs ?? [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(deviceId
      ? {
          deviceLinkDeviceId: deviceId,
          deviceLinkDeviceName: parentSession?.deviceLinkDeviceName,
          deviceLinkConnectionStatus: parentSession?.deviceLinkConnectionStatus ?? 'connected',
        }
      : {}),
  };
}

export function registerPendingSideChat(
  record: Omit<PendingSideChatRecord, 'ownerGeneration' | 'hasQueuedSend'>,
): PendingSideChatRecord {
  const entry: PendingSideChatRecord = {
    ...record,
    hasQueuedSend: false,
    ownerGeneration: getDataOwnerGeneration(),
  };
  records.set(record.tabId, entry);
  emit();
  return entry;
}

export function getPendingSideChat(tabId: string | null | undefined): PendingSideChatRecord | undefined {
  if (!tabId) return undefined;
  const entry = records.get(tabId);
  if (!entry) return undefined;
  if (!isDataOwnerGenerationCurrent(entry.ownerGeneration)) {
    records.delete(tabId);
    return undefined;
  }
  return entry;
}

export function resolvePendingSideChat(tabId: string, childSession: Session): PendingSideChatRecord | undefined {
  const current = getPendingSideChat(tabId);
  if (!current || current.status === 'cancelled') return undefined;
  const next: PendingSideChatRecord = {
    ...current,
    status: 'ready',
    childSession,
    errorMessage: undefined,
  };
  records.set(tabId, next);
  emit();
  return next;
}

export function failPendingSideChat(tabId: string, errorMessage: string, childSession?: Session): PendingSideChatRecord | undefined {
  const current = getPendingSideChat(tabId);
  if (!current || current.status === 'cancelled') return undefined;
  const next: PendingSideChatRecord = {
    ...current,
    status: 'failed',
    errorMessage,
    childSession: childSession ?? current.childSession,
  };
  records.set(tabId, next);
  emit();
  return next;
}

export function markPendingSideChatRetrying(tabId: string): PendingSideChatRecord | undefined {
  const current = getPendingSideChat(tabId);
  if (!current || current.status === 'cancelled') return undefined;
  const next: PendingSideChatRecord = {
    ...current,
    status: 'creating',
    errorMessage: undefined,
  };
  records.set(tabId, next);
  emit();
  return next;
}

export function setPendingSideChatQueuedSend(tabId: string, queued: boolean): boolean {
  const current = getPendingSideChat(tabId);
  if (!current || current.status === 'cancelled') return false;
  if (current.hasQueuedSend !== queued) {
    records.set(tabId, { ...current, hasQueuedSend: queued });
    emit();
  }
  return true;
}

export function cancelPendingSideChat(tabId: string): PendingSideChatRecord | undefined {
  const current = getPendingSideChat(tabId);
  if (!current) return undefined;
  const next: PendingSideChatRecord = { ...current, status: 'cancelled' };
  records.set(tabId, next);
  emit();
  return next;
}

export function removePendingSideChat(tabId: string): void {
  if (records.delete(tabId)) emit();
}

export function hasInFlightSideChatForParent(parentSessionId: string): boolean {
  for (const [tabId, entry] of records) {
    if (!isDataOwnerGenerationCurrent(entry.ownerGeneration)) {
      records.delete(tabId);
      continue;
    }
    if (entry.parentSessionId === parentSessionId && entry.status === 'creating') {
      return true;
    }
  }
  return false;
}

export function isChildClaimedByPendingSideChat(parentSessionId: string, childSessionId: string): boolean {
  for (const [tabId, entry] of records) {
    if (!isDataOwnerGenerationCurrent(entry.ownerGeneration)) {
      records.delete(tabId);
      continue;
    }
    if (entry.parentSessionId === parentSessionId && entry.childSession?.id === childSessionId) {
      return true;
    }
  }
  return false;
}

export function subscribePendingSideChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetPendingSideChatsForTest(): void {
  records.clear();
  listeners.clear();
}
