import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  parseSharedTaskPeer,
  SHARED_TASK_HOST_CHANNEL,
  type SharedTaskHostState,
} from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { SharedTaskButton } from '@/features/device-link/SharedTaskButton';
import {
  SharedTaskExitDialog,
  type SharedTaskExitTarget,
} from '@/features/device-link/SharedTaskExitDialog';
import { useAuth } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import { declaredGhostControlPoints } from '../../../../shared/ghost';
import { isRuntimePluginPoint } from '../../../../shared/pluginRuntime';
import { sharedTaskErrorKey } from '@/features/device-link/sharedTaskCompatibility';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { isEmptyDraftSession } from '../lib/sessionDisplayTitle';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import {
  TaskMoveSubmenu,
  moveRemoteTaskProject,
  type TaskMoveDestination,
} from './TaskMoveSubmenu';
import { TaskMigrationDialog } from './TaskMigrationDialog';
import { TaskRuntimePluginsDialog } from './TaskRuntimePluginsDialog';
import { setSessionNotificationsMuted } from './sessionNotificationMute';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from './menuStyles';
import { readPluginUiEntries, PluginUiSessionMenuItems } from '@/cindy-brain/PluginUiContributions';
import { clearSessionAttention, hasSessionAttention } from '@/lib/sessionAttentionStore';
import { refreshPendingAlerts } from '@/hooks/usePendingAlertAttention';
import { createLogger } from '@/lib/logger';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { useAutomationScheduleSessionInfo } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import { markScheduleRunsReadAndSync } from '@/features/scheduler/lib/scheduleRunReadSync';

const log = createLogger('SessionTaskMenu');

// Native window dragging ignores portal stacking. Leave 8px below the 50px drag
// strip so the first item remains clickable when a tall menu flips upward.
const TASK_MENU_COLLISION_PADDING = { top: 58, right: 8, bottom: 8, left: 8 };

interface Props {
  session: Session;
  open: boolean;
  writeBlocked: boolean;
  sideOffset?: number;
  returnFocus: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onOpenInNewWindow: () => void;
  move: ReactNode;
  tags: ReactNode;
  copy: ReactNode;
  exportShare: ReactNode;
}

type SharingDialog =
  | { kind: 'manage' }
  | { kind: 'migration'; destination?: TaskMoveDestination }
  | { kind: 'browse-project' }
  | { kind: 'runtime-plugins' }
  | SharedTaskExitTarget;

/** One menu order for the header, text rows and cards. Keep row-specific action handlers. */
export function SessionTaskMenu(props: Props) {
  const [dialog, setDialog] = useState<SharingDialog | null>(null);
  // Do not mount sharing controls for every idle sidebar row.
  if (!props.open && !dialog) return null;
  return <ActiveSessionTaskMenu {...props} dialog={dialog} setDialog={setDialog} />;
}

function ActiveSessionTaskMenu({
  session,
  open,
  writeBlocked,
  sideOffset = 4,
  returnFocus,
  onRename,
  onPin,
  onArchive,
  onUnarchive,
  onDelete,
  onOpenInNewWindow,
  move,
  tags,
  copy,
  exportShare,
  dialog,
  setDialog,
}: Props & {
  dialog: SharingDialog | null;
  setDialog: (dialog: SharingDialog | null) => void;
}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  const peer = parseSharedTaskPeer(session.deviceLinkDeviceId ?? '');
  const guest = peer?.role === 'host';
  // 行的「未读」不只来自本地 attention 表：device-link 远程会话行的未读终态由被控端
  // 活动镜像（remoteSessionActivityStore）点亮，定时任务后台跑完的 run 未读由 schedule
  // 索引点亮。二者都要算进「标为已读」的可用性，否则行上有绿点却没有入口。
  const remoteActivity = useRemoteSessionActivity(session.id, session.deviceLinkDeviceId);
  const scheduleInfo = useAutomationScheduleSessionInfo(session.id);
  const remoteUnread =
    session.deviceLinkDeviceId != null &&
    remoteActivity?.attention === true &&
    (remoteActivity.phase === 'completed' || remoteActivity.phase === 'error');
  const showMarkAsRead =
    hasSessionAttention(session.id) || remoteUnread || scheduleInfo?.hasUnreadRun === true;
  const [sharing, setSharing] = useState<SharedTaskHostState | null>(null);
  const [copying, setCopying] = useState(false);
  const copyPending = useRef(false);
  const copyEpoch = useRef(0);
  useEffect(() => {
    copyPending.current = false;
    setCopying(false);
    return () => {
      copyEpoch.current++;
    };
  }, [dataOwnerId, ownerGeneration]);
  useEffect(() => {
    if (!open || guest || session.status !== 'active') return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setSharing(null);
    const command = { action: 'state' as const, sessionId: session.id };
    const load = async () => {
      try {
        const result = (await (session.deviceLinkDeviceId
          ? window.electronAPI.deviceLink.invoke(
              session.deviceLinkDeviceId,
              SHARED_TASK_HOST_CHANNEL,
              [command],
            )
          : window.electronAPI.sharedTask.host(command))) as SharedTaskHostState;
        if (!disposed && isDataOwnerGenerationCurrent(owner)) setSharing(result);
      } catch {
        /* Management retains its existing retry and upgrade UI. */
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [
    open,
    guest,
    session.id,
    session.status,
    session.deviceLinkDeviceId,
    dataOwnerId,
    ownerGeneration,
  ]);
  const hosted = sharing?.detail?.status === 'active' ? sharing.detail : null;
  const copyInvitation = async () => {
    if (!hosted || copyPending.current) return;
    copyPending.current = true;
    setCopying(true);
    const owner = getDataOwnerGeneration();
    const captured = copyEpoch.current;
    const current = () => captured === copyEpoch.current && isDataOwnerGenerationCurrent(owner);
    try {
      const command = { action: 'invite' as const, sharedTaskId: hosted.sharedTaskId };
      const result = (await (session.deviceLinkDeviceId
        ? window.electronAPI.deviceLink.invoke(
            session.deviceLinkDeviceId,
            SHARED_TASK_HOST_CHANNEL,
            [command],
          )
        : window.electronAPI.sharedTask.host(command))) as { invitation: string; invitationLink?: string };
      if (!current()) return;
      try {
        await navigator.clipboard.writeText(result.invitationLink
          ? t('sharedTask.invitationMessage', { title: hosted.title || session.title, link: result.invitationLink })
          : result.invitation);
      } catch {
        if (current()) toast.error(t('sharedTask.invitationCopyFailed'));
        return;
      }
      if (current()) toast.success(t('sharedTask.invitationCopied'));
    } catch (error) {
      if (current()) toast.error(t(sharedTaskErrorKey(error)));
    } finally {
      if (current()) {
        copyPending.current = false;
        setCopying(false);
      }
    }
  };
  const openSharing = () => {
    if (guest && peer)
      setDialog({
        kind: 'leave',
        sharedTaskId: peer.sharedTaskId,
        title: session.title,
        peer: session.deviceLinkDeviceId!,
      });
    else if (hosted)
      setDialog({
        kind: 'close',
        sharedTaskId: hosted.sharedTaskId,
        title: session.title,
        hostDeviceId: session.deviceLinkDeviceId || undefined,
      });
    else setDialog({ kind: 'manage' });
  };
  const dismissSharing = () => {
    setDialog(null);
    // Restore the row after the confirmation's focus scope has unmounted.
    requestAnimationFrame(returnFocus);
  };
  const archived = session.status === 'archived';
  const empty = isEmptyDraftSession(session);
  const ownerActionsBlocked = writeBlocked || guest;
  const showRuntimePlugins = !session.deviceLinkDeviceId && (
    session.runtimePluginsSelected === true || readInstalledGhostsSnapshot().some(ghost =>
      declaredGhostControlPoints(ghost.manifest).some(isRuntimePluginPoint))
  );
  const pluginActions = !guest && !session.deviceLinkDeviceId ? readPluginUiEntries('session.menu') : [];
  const item = (key: string, action: () => void, disabled = false) => (
    <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={disabled} onSelect={action}>
      {t(`ccAgent.sidebar.sessionMenu.${key}`)}
    </DropdownMenuItem>
  );
  const separator = <DropdownMenuSeparator />;
  return (
    <div
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <DropdownMenuContent
        align="start"
        sideOffset={sideOffset}
        collisionPadding={TASK_MENU_COLLISION_PADDING}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-32 overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (dialog) event.preventDefault();
        }}
      >
        {!guest && (
          <>
            {!archived &&
              !empty &&
              item(session.pinnedAt != null ? 'unpin' : 'pin', onPin, ownerActionsBlocked)}
            {showMarkAsRead && (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                disabled={ownerActionsBlocked}
                onSelect={async () => {
                  const deviceId = session.deviceLinkDeviceId ?? undefined;
                  // 显式清除：本地无记录时也照样发已读回执，远程行的未读靠被控端收敛。
                  clearSessionAttention(session.id, deviceId ? { intent: 'explicit' } : undefined);
                  if (!deviceId) {
                    try {
                      const { processed } =
                        await window.electronAPI.localDb.sessions.dismissPendingAlerts([session.id]);
                      if (processed.includes(session.id)) {
                        clearSessionAttention(session.id, { intent: 'explicit' });
                      }
                    } catch (e) {
                      log.warn('dismiss pending alerts failed', e);
                    }
                    void refreshPendingAlerts();
                  }
                  // 定时任务后台跑完的 run 未读不走 attention 表：与自动化分组的
                  // 「标为已读」一致，把该会话未读的 run 一并标记已读，否则绿点会留在原地。
                  const unreadRunIds = scheduleInfo?.unreadRunIds ?? [];
                  if (unreadRunIds.length > 0) {
                    const { processed, failed, firstError } = await markScheduleRunsReadAndSync(
                      unreadRunIds,
                      deviceId,
                    );
                    if (processed.length > 0) {
                      toast.success(t('ccAgent.layout.markedAsRead', { count: processed.length }));
                    }
                    if (failed.length > 0) {
                      toast.error(
                        t('ccAgent.layout.markAllReadFailed', {
                          error: firstError ?? String(failed.length),
                        }),
                      );
                    }
                  }
                }}
              >
                {/* 键名沿用分组菜单的既有文案键（值本就是单任务措辞：en "Mark as read"、
                    zh-CN「标为已读」），避免为一个菜单项新增 12 份语言包。 */}
                {t('ccAgent.sidebar.automationGroup.menu.markAllAsRead')}
              </DropdownMenuItem>
            )}
            {item('rename', onRename, ownerActionsBlocked)}
            {/* 提醒归任务所在的那台设备发，device-link 任务（别人的任务）在这里设不了。 */}
            {!archived && !empty && !session.deviceLinkDeviceId && (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                disabled={ownerActionsBlocked}
                onSelect={() => {
                  void setSessionNotificationsMuted(
                    session,
                    session.notificationsMuted !== true,
                  ).catch(() => toast.error(t('ccAgent.sidebar.muteNotificationsFailed')));
                }}
              >
                {t(
                  session.notificationsMuted
                    ? 'ccAgent.sidebar.sessionMenu.unmuteNotifications'
                    : 'ccAgent.sidebar.sessionMenu.muteNotifications',
                )}
              </DropdownMenuItem>
            )}
            {tags}
            {showRuntimePlugins && <DropdownMenuItem className={MENU_ITEM_CLASS}
              disabled={ownerActionsBlocked} onSelect={() => setDialog({ kind: 'runtime-plugins' })}>
              {t('runtimePlugins.title')}
            </DropdownMenuItem>}
            {separator}
            {copy}
          </>
        )}
        {session.status === 'active' &&
          (hosted && !guest ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
                <span className="flex-1">{t('sharedTask.manageSharing')}</span>
                <ChevronRight
                  size={14}
                  className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]"
                  aria-hidden
                />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={4}
                className="min-w-40"
              >
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={copying || writeBlocked}
                  onSelect={(event) => {
                    event.preventDefault();
                    void copyInvitation();
                  }}
                >
                  {t('sharedTask.invite')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={copying}
                  onSelect={() => setDialog({ kind: 'manage' })}
                >
                  {t('sharedTask.manageMembers')}
                </DropdownMenuItem>
                {separator}
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={copying}
                  onSelect={openSharing}
                >
                  {t('sharedTask.cancelSharing')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={openSharing}>
              {t(guest ? 'sharedTask.leaveShort' : 'sharedTask.title')}
            </DropdownMenuItem>
          ))}
        {!guest && (
          <>
            {!archived && !empty && !session.remoteHostId && (
              <TaskMoveSubmenu
                session={session}
                disabled={ownerActionsBlocked}
                localProjects={move}
                onMigration={(destination) => setDialog({ kind: 'migration', destination })}
                onBrowseRemote={() => setDialog({ kind: 'browse-project' })}
              />
            )}
            {exportShare}
            {!archived && !empty && (
              <>
                {separator}
                {item('openInNewWindow', onOpenInNewWindow, ownerActionsBlocked)}
              </>
            )}
            {pluginActions.length > 0 && <PluginUiSessionMenuItems sessionId={session.id}
              disabled={ownerActionsBlocked || archived} className={MENU_ITEM_CLASS} />}
            {separator}
            {archived
              ? item('unarchive', onUnarchive, ownerActionsBlocked)
              : !empty && item('archived', onArchive, ownerActionsBlocked)}
            {item('delete', onDelete, ownerActionsBlocked)}
          </>
        )}
      </DropdownMenuContent>
      {dialog?.kind === 'manage' && (
        <SharedTaskButton
          session={session}
          dialogControl={{
            onDismiss: () => setDialog(null),
            returnFocus,
          }}
        />
      )}
      {dialog?.kind === 'runtime-plugins' && <TaskRuntimePluginsDialog session={session} onDismiss={dismissSharing} />}
      {dialog?.kind === 'migration' && (
        <TaskMigrationDialog
          session={session}
          destination={dialog.destination}
          onDismiss={dismissSharing}
        />
      )}
      {dialog?.kind === 'browse-project' && session.deviceLinkDeviceId && (
        <AddRemoteProjectDialog
          open
          onOpenChange={(open) => {
            if (!open) dismissSharing();
          }}
          initialDeviceId={session.deviceLinkDeviceId}
          fixedDeviceId={session.deviceLinkDeviceId}
          title={t('ccAgent.sidebar.sessionMenu.moveToProject')}
          confirmText={t('ccAgent.sidebar.sessionMenu.moveToProject')}
          errorText={t('taskMove.failed')}
          onProjectAdded={async (target) => {
            if (target.kind !== 'device-link' || target.deviceId !== session.deviceLinkDeviceId)
              throw new Error('MIGRATION_ACCESS_REVOKED');
            await moveRemoteTaskProject(session, target.path);
          }}
        />
      )}
      {dialog &&
        dialog.kind !== 'browse-project' &&
        dialog.kind !== 'manage' &&
        dialog.kind !== 'migration' &&
        dialog.kind !== 'runtime-plugins' && (
          <SharedTaskExitDialog
            target={dialog}
            onDismiss={dismissSharing}
            onComplete={dismissSharing}
          />
        )}
    </div>
  );
}
