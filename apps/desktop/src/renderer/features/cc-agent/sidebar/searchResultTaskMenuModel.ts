import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import type { ConversationSearchSessionSummary } from '../../../../shared/conversationSearch';
import type { SessionMoveTarget } from './sessionMoveTarget';

/**
 * Surfaces considered "inside" an active conversation search interaction so
 * pointer/focus events inside right-click menus, submenus, tag/export/share/
 * migration/confirm dialogs, or modal scrims do not dismiss the search overlay
 * or rail popover and unmount an open dialog mid-interaction.
 */
export const CONVERSATION_SEARCH_KEEPALIVE_SELECTOR =
  '[data-conversation-search-surface],[data-radix-popper-content-wrapper],[role="dialog"],[role="alertdialog"],.modal-scrim';

export type SearchSessionHydrationStatus = 'ready' | 'loading' | 'failed';

export interface SearchResultTaskMenuProps {
  session: Session;
  isLiveInStore: boolean;
  hydrationStatus?: SearchSessionHydrationStatus;
  onRetryHydration?: () => void;
  menuPos: { x: number; y: number } | null;
  isEditing: boolean;
  actions: SearchResultTaskMenuActions;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onOutOfWindowPatch: (patch: Partial<Session>) => void;
  returnFocus: () => void;
}

export interface SearchResultTaskMenuActions {
  /** Concrete task context menu renderer supplied by the sidebar shell. */
  MenuComponent: ComponentType<SearchResultTaskMenuProps>;
  /** Look up the latest live Session from sidebar/remote stores when available. */
  resolveSession: (summary: ConversationSearchSessionSummary) => Session | null;
  /** Connection status for remote sessions outside the sidebar mirror window. */
  getRemoteConnectionStatus?: (deviceId: string) => DeviceLinkConnectionStatus | null;
  onAction: (
    sessionId: string,
    action: 'delete' | 'archive' | 'unarchive',
    session?: Session,
  ) => void | Promise<unknown>;
  onRename: (sessionId: string, newTitle: string, session?: Session) => void | Promise<unknown>;
  onTogglePin: (
    sessionId: string,
    currentlyPinned: boolean,
    session?: Session,
  ) => void | Promise<unknown>;
  onMoveSession?: (
    sessionId: string,
    target: SessionMoveTarget,
    session?: Session,
  ) => void | Promise<unknown>;
  projectOptions?: readonly FolderPickerOption[];
}

/**
 * Companion canonical chats and archived companion histories are teammate chats
 * rather than user-managed tasks (they use BotSessionContentHeader rather than
 * SessionTaskMenu). Every other search result opens the standard task menu.
 */
export function canOpenSearchResultTaskMenu(summary: ConversationSearchSessionSummary): boolean {
  const role = summary.companion?.role;
  return role !== 'canonical' && role !== 'history';
}

/**
 * Fallback Session projection when a search hit falls outside the sidebar's
 * bounded in-memory session cache (e.g. >1000 archived local tasks or an older
 * remote task outside the mirror window).
 */
export function buildFallbackSessionFromSearchSummary(
  summary: ConversationSearchSessionSummary,
  remoteConnectionStatus?: DeviceLinkConnectionStatus | null,
): Session {
  return {
    id: summary.id,
    userId: '',
    title: summary.title,
    workingDir: summary.workingDir,
    projectDir: summary.projectDir,
    workspaceKind: summary.workspaceKind,
    model: '',
    effort: 'medium',
    permissionMode: 'auto',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: summary.userSendAt,
    status: summary.status,
    agentKind: summary.agentKind,
    source: summary.source,
    orcaRole: summary.orcaRole,
    parentSessionId: summary.parentSessionId,
    extraDirs: [],
    tags: summary.tags,
    ...(summary.deviceLinkDeviceId
      ? {
          deviceLinkDeviceId: summary.deviceLinkDeviceId,
          deviceLinkDeviceName: summary.deviceLinkDeviceName ?? undefined,
          deviceLinkConnectionStatus: remoteConnectionStatus ?? 'connected',
        }
      : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    _count: summary._count,
  };
}

/**
 * On-demand authoritative session fetch for search hits absent from live stores
 * so pinnedAt, notificationsMuted, remoteHostId, runtimePluginsSelected, etc.
 * match the sidebar task menu even for out-of-window tasks.
 *
 * Until authoritative data arrives, `hydrationStatus` stays `'loading'` (or
 * `'failed'` on error/missing row) so callers can gate mutations that depend on
 * fields absent from the search summary and offer an explicit retry.
 */
export function useHydratedSearchSession({
  summary,
  liveSession,
  sessionPatch,
  menuOpen,
  remoteConnectionStatus,
}: {
  summary: ConversationSearchSessionSummary;
  liveSession: Session | null;
  sessionPatch?: Partial<Session> | null;
  menuOpen: boolean;
  remoteConnectionStatus?: DeviceLinkConnectionStatus | null;
}): {
  session: Session;
  hydrationStatus: SearchSessionHydrationStatus;
  retryHydration: () => void;
  applyOutOfWindowPatch: (patch: Partial<Session>) => void;
} {
  const identityKey = `${summary.deviceLinkDeviceId ?? ''}:${summary.id}`;
  const [hydrationState, setHydrationState] = useState<{
    key: string;
    status: SearchSessionHydrationStatus;
    session: Session | null;
  } | null>(null);
  const [outOfWindowPatch, setOutOfWindowPatch] = useState<{
    key: string;
    patch: Partial<Session>;
  } | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  const remoteDeviceId = summary.deviceLinkDeviceId ?? null;
  const skipHydration =
    liveSession !== null ||
    (remoteDeviceId !== null &&
      (isSharedTaskPeer(remoteDeviceId) ||
        remoteConnectionStatus === 'disconnected' ||
        remoteConnectionStatus === 'connecting'));

  const hydrated =
    hydrationState?.key === identityKey && hydrationState.status === 'ready'
      ? hydrationState.session
      : null;
  const activePatch = outOfWindowPatch?.key === identityKey ? outOfWindowPatch.patch : null;

  const hydrationStatus: SearchSessionHydrationStatus = skipHydration
    ? 'ready'
    : hydrated !== null
      ? 'ready'
      : hydrationState?.key === identityKey
        ? hydrationState.status
        : 'loading';

  useEffect(() => {
    if (!menuOpen || skipHydration || hydrated !== null) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setHydrationState({ key: identityKey, status: 'loading', session: null });
    const fetchSession = async () => {
      try {
        const fetched = remoteDeviceId
          ? ((await window.electronAPI.deviceLink?.invoke(remoteDeviceId, 'local-db:sessions:get', [
              summary.id,
            ])) as Session | null | undefined)
          : await sessionService.get(summary.id);
        if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
        if (!fetched || fetched.id !== summary.id) {
          setHydrationState({ key: identityKey, status: 'failed', session: null });
          return;
        }
        const stamped: Session = remoteDeviceId
          ? {
              ...fetched,
              deviceLinkDeviceId: remoteDeviceId,
              deviceLinkDeviceName:
                fetched.deviceLinkDeviceName ?? summary.deviceLinkDeviceName ?? undefined,
              deviceLinkConnectionStatus: remoteConnectionStatus ?? 'connected',
            }
          : fetched;
        setHydrationState({ key: identityKey, status: 'ready', session: stamped });
        setOutOfWindowPatch((prev) => (prev?.key === identityKey ? null : prev));
      } catch {
        if (!disposed && isDataOwnerGenerationCurrent(owner)) {
          setHydrationState({ key: identityKey, status: 'failed', session: null });
        }
      }
    };
    void fetchSession();
    return () => {
      disposed = true;
    };
  }, [
    hydrated,
    identityKey,
    menuOpen,
    remoteConnectionStatus,
    remoteDeviceId,
    retrySeq,
    skipHydration,
    summary.deviceLinkDeviceName,
    summary.id,
  ]);

  const retryHydration = useCallback(() => {
    setRetrySeq((seq) => seq + 1);
  }, []);

  const applyOutOfWindowPatch = useCallback(
    (patch: Partial<Session>) => {
      setOutOfWindowPatch((prev) => ({
        key: identityKey,
        patch: prev?.key === identityKey ? { ...prev.patch, ...patch } : patch,
      }));
    },
    [identityKey],
  );

  const base =
    liveSession ??
    hydrated ??
    buildFallbackSessionFromSearchSummary(summary, remoteConnectionStatus);

  const mergedOutOfWindowPatch =
    liveSession === null && (sessionPatch || activePatch)
      ? {
          ...(activePatch ?? {}),
          ...(sessionPatch ?? {}),
        }
      : null;

  const session =
    liveSession !== null
      ? liveSession
      : mergedOutOfWindowPatch
        ? {
            ...base,
            ...mergedOutOfWindowPatch,
            ...(summary.deviceLinkDeviceId
              ? { deviceLinkConnectionStatus: remoteConnectionStatus ?? base.deviceLinkConnectionStatus }
              : {}),
          }
        : summary.deviceLinkDeviceId && remoteConnectionStatus
          ? { ...base, deviceLinkConnectionStatus: remoteConnectionStatus }
          : base;

  return { session, hydrationStatus, retryHydration, applyOutOfWindowPatch };
}
