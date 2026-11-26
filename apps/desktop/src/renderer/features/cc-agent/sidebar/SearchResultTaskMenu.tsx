import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';

import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { TaskTagEditor, TaskTagMenuSection } from '@/features/task-tags/TaskTags';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';
import { isEmptyDraftSession } from '../lib/sessionDisplayTitle';
import { MENU_ITEM_CLASS } from './menuStyles';
import { SessionProjectMoveSubmenu } from './SessionProjectMoveSubmenu';
import { SessionShareExportDialog } from './SessionShareExportDialog';
import { SessionTaskMenu } from './SessionTaskMenu';
import type {
  SearchResultTaskMenuActions,
  SearchResultTaskMenuProps,
} from './searchResultTaskMenuModel';

export {
  buildFallbackSessionFromSearchSummary,
  canOpenSearchResultTaskMenu,
  CONVERSATION_SEARCH_KEEPALIVE_SELECTOR,
  useHydratedSearchSession,
  type SearchResultTaskMenuActions,
  type SearchResultTaskMenuProps,
  type SearchSessionHydrationStatus,
} from './searchResultTaskMenuModel';

const log = createLogger('SearchResultTaskMenu');

export function createSearchResultTaskMenuActions(
  actions: Omit<SearchResultTaskMenuActions, 'MenuComponent'>,
): SearchResultTaskMenuActions {
  return {
    ...actions,
    MenuComponent: SearchResultTaskMenu,
  };
}

export function SearchResultTaskMenu({
  session,
  isLiveInStore,
  hydrationStatus = 'ready',
  onRetryHydration,
  menuPos,
  isEditing,
  actions,
  onCloseMenu,
  onStartRename,
  onOutOfWindowPatch,
  returnFocus,
}: SearchResultTaskMenuProps) {
  const { t } = useTranslation();
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [shareExportOpen, setShareExportOpen] = useState(false);

  const isPinned = session.pinnedAt != null;
  const isEmpty = isEmptyDraftSession(session);
  const remoteWritesBlocked =
    isSharedTaskPeer(session.deviceLinkDeviceId ?? '') || isRemoteSessionWriteBlocked(session);
  const hydrationBlocked = hydrationStatus !== 'ready';
  const menuWritesBlocked = remoteWritesBlocked || hydrationBlocked;

  const ensureRemoteOriginPinned = useCallback(() => {
    if (session.deviceLinkDeviceId) {
      remoteProjectsStore.pinSessionOrigin(session.deviceLinkDeviceId, session.id);
    }
  }, [session.deviceLinkDeviceId, session.id]);

  const handleRenameSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    ensureRemoteOriginPinned();
    onStartRename();
  }, [ensureRemoteOriginPinned, hydrationBlocked, onStartRename, remoteWritesBlocked, t]);

  const handlePinSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    ensureRemoteOriginPinned();
    const prevPinnedAt = session.pinnedAt;
    const nextPinnedAt = isPinned ? null : new Date().toISOString();
    if (!isLiveInStore && session.deviceLinkDeviceId) {
      onOutOfWindowPatch({ pinnedAt: nextPinnedAt });
    }
    void Promise.resolve(actions.onTogglePin(session.id, isPinned, session)).then((ok) => {
      if (ok === false && !isLiveInStore && session.deviceLinkDeviceId) {
        onOutOfWindowPatch({ pinnedAt: prevPinnedAt });
      }
    });
  }, [
    actions,
    ensureRemoteOriginPinned,
    hydrationBlocked,
    isLiveInStore,
    isPinned,
    onOutOfWindowPatch,
    remoteWritesBlocked,
    session,
    t,
  ]);

  const handleArchiveSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    ensureRemoteOriginPinned();
    void actions.onAction(session.id, 'archive', session);
  }, [actions, ensureRemoteOriginPinned, hydrationBlocked, remoteWritesBlocked, session, t]);

  const handleUnarchiveSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    ensureRemoteOriginPinned();
    void actions.onAction(session.id, 'unarchive', session);
  }, [actions, ensureRemoteOriginPinned, hydrationBlocked, remoteWritesBlocked, session, t]);

  const handleDeleteSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    ensureRemoteOriginPinned();
    void actions.onAction(session.id, 'delete', session);
  }, [actions, ensureRemoteOriginPinned, hydrationBlocked, remoteWritesBlocked, session, t]);

  const handleOpenInNewWindowSelect = useCallback(() => {
    if (hydrationBlocked) return;
    if (remoteWritesBlocked) {
      toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
      return;
    }
    void window.electronAPI.maker.openSessionInNewWindow(session.id, session.deviceLinkDeviceId);
  }, [hydrationBlocked, remoteWritesBlocked, session.deviceLinkDeviceId, session.id, t]);

  const handleCopyDeepLinkSelect = useCallback(async () => {
    const link = buildSessionDeepLink(session.id, { deviceId: session.deviceLinkDeviceId });
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('ccAgent.sidebar.deepLink.copied'));
    } catch (err) {
      log.warn('clipboard write failed', err);
      toast.warning(t('ccAgent.sidebar.deepLink.copyFailed'));
    }
  }, [session.deviceLinkDeviceId, session.id, t]);

  const handleMoveToProjectSelect = useCallback(
    (workingDir: string) => {
      void actions.onMoveSession?.(session.id, { kind: 'project', workingDir }, session);
    },
    [actions, session],
  );

  const handleMoveToProjectBrowse = useCallback(() => {
    void actions.onMoveSession?.(session.id, { kind: 'browseProject' }, session);
  }, [actions, session]);

  const handleMoveToNewProject = useCallback(() => {
    void actions.onMoveSession?.(session.id, { kind: 'newProject' }, session);
  }, [actions, session]);

  const handleMoveToDialogue = useCallback(() => {
    void actions.onMoveSession?.(session.id, { kind: 'dialogue' }, session);
  }, [actions, session]);

  const handleExportShareSelect = useCallback(() => {
    if (hydrationBlocked) return;
    setShareExportOpen(true);
  }, [hydrationBlocked]);

  const canMoveToProject =
    !hydrationBlocked &&
    Boolean(actions.onMoveSession) &&
    !isEmpty &&
    !session.remoteHostId &&
    !session.deviceLinkDeviceId &&
    session.status !== 'archived';

  const canExportShare =
    !hydrationBlocked &&
    !isEmpty &&
    !session.remoteHostId &&
    session.orcaRole !== 'worker' &&
    !session.deviceLinkDeviceId;

  const statusNotice =
    hydrationStatus === 'loading' ? (
      <>
        <div role="status" className="px-2 py-1 text-xs text-[var(--cmd-palette-item-meta)]">
          {t('taskMove.loading')}
        </div>
        <DropdownMenuSeparator />
      </>
    ) : hydrationStatus === 'failed' ? (
      <>
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={(event) => {
            event.preventDefault();
            onRetryHydration?.();
          }}
        >
          {t('taskMove.retry')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>
    ) : null;

  const tagMenu = hydrationBlocked ? null : (
    <TaskTagMenuSection
      session={session}
      onMore={() => {
        setTagEditorOpen(true);
        onCloseMenu();
      }}
    />
  );

  const copySessionIdSubmenu = (
    <DropdownMenuItem onSelect={() => void handleCopyDeepLinkSelect()} className={MENU_ITEM_CLASS}>
      {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
    </DropdownMenuItem>
  );

  const exportShareMenuItem = canExportShare ? (
    <DropdownMenuItem onSelect={handleExportShareSelect} className={MENU_ITEM_CLASS}>
      {t('ccAgent.sidebar.sessionMenu.exportShare')}
    </DropdownMenuItem>
  ) : null;

  const moveToProjectSubmenu = canMoveToProject ? (
    <SessionProjectMoveSubmenu
      projectOptions={actions.projectOptions ?? []}
      currentSession={session}
      isDialogue={session.workspaceKind === 'dialogue'}
      onSelectProject={handleMoveToProjectSelect}
      onBrowseProject={handleMoveToProjectBrowse}
      onNewProject={handleMoveToNewProject}
      onMoveToDialogue={handleMoveToDialogue}
    />
  ) : null;

  return (
    <>
      {!isEditing && (
        <DropdownMenu
          open={menuPos !== null}
          onOpenChange={(open) => {
            if (!open) onCloseMenu();
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: menuPos?.x ?? 0,
                top: menuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <SessionTaskMenu
            key={`${session.deviceLinkDeviceId ?? ''}:${session.id}`}
            session={session}
            open={menuPos !== null}
            sideOffset={2}
            writeBlocked={menuWritesBlocked}
            statusNotice={statusNotice}
            returnFocus={returnFocus}
            onRename={handleRenameSelect}
            onPin={handlePinSelect}
            onArchive={handleArchiveSelect}
            onUnarchive={handleUnarchiveSelect}
            onDelete={handleDeleteSelect}
            onOpenInNewWindow={handleOpenInNewWindowSelect}
            move={moveToProjectSubmenu}
            tags={tagMenu}
            copy={copySessionIdSubmenu}
            exportShare={exportShareMenuItem}
          />
        </DropdownMenu>
      )}
      {tagEditorOpen && (
        <TaskTagEditor
          session={session}
          onClose={() => {
            setTagEditorOpen(false);
            requestAnimationFrame(returnFocus);
          }}
        />
      )}
      {shareExportOpen && (
        <SessionShareExportDialog
          open={shareExportOpen}
          sessionId={session.id}
          onOpenChange={setShareExportOpen}
        />
      )}
    </>
  );
}
