import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseSharedTaskPeer, SHARED_TASK_HOST_CHANNEL, type SharedTaskHostState } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { SharedTaskButton } from '@/features/device-link/SharedTaskButton';
import { SharedTaskExitDialog, type SharedTaskExitTarget } from '@/features/device-link/SharedTaskExitDialog';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
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
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_ROW_CLASS, MENU_SEPARATOR_CLASS, MENU_SUB_CONTENT_CLASS } from './menuStyles';

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

type SharingDialog = { kind: 'manage' } | SharedTaskExitTarget;

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
  const [sharing, setSharing] = useState<SharedTaskHostState | null>(null);
  const [loadingSharing, setLoadingSharing] = useState(!guest);
  const [copying, setCopying] = useState(false);
  const copyPending = useRef(false);
  const copyEpoch = useRef(0);
  useEffect(() => {
    copyPending.current = false; setCopying(false);
    return () => { copyEpoch.current++; };
  }, [dataOwnerId, ownerGeneration]);
  useEffect(() => {
    if (!open || guest || session.status !== 'active') return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    setSharing(null); setLoadingSharing(true);
    const command = { action: 'state' as const, sessionId: session.id };
    const load = async () => {
      try {
        const result = await (session.deviceLinkDeviceId
          ? window.electronAPI.deviceLink.invoke(session.deviceLinkDeviceId, SHARED_TASK_HOST_CHANNEL, [command])
          : window.electronAPI.sharedTask.host(command)) as SharedTaskHostState;
        if (!disposed && isDataOwnerGenerationCurrent(owner)) setSharing(result);
      } catch { /* Management retains its existing retry and upgrade UI. */ }
      finally { if (!disposed && isDataOwnerGenerationCurrent(owner)) setLoadingSharing(false); }
    };
    void load();
    return () => { disposed = true; };
  }, [open, guest, session.id, session.status, session.deviceLinkDeviceId, dataOwnerId, ownerGeneration]);
  const hosted = sharing?.detail?.status === 'active' ? sharing.detail : null;
  const copyInvitation = async () => {
    if (!hosted || copyPending.current) return;
    copyPending.current = true; setCopying(true);
    const owner = getDataOwnerGeneration();
    const captured = copyEpoch.current;
    const current = () => captured === copyEpoch.current && isDataOwnerGenerationCurrent(owner);
    try {
      const command = { action: 'invite' as const, sharedTaskId: hosted.sharedTaskId };
      const result = await (session.deviceLinkDeviceId
        ? window.electronAPI.deviceLink.invoke(session.deviceLinkDeviceId, SHARED_TASK_HOST_CHANNEL, [command])
        : window.electronAPI.sharedTask.host(command)) as { invitation: string };
      if (!current()) return;
      try { await navigator.clipboard.writeText(result.invitation); }
      catch { if (current()) toast.error(t('sharedTask.invitationCopyFailed')); return; }
      if (current()) toast.success(t('sharedTask.invitationCopied'));
    } catch (error) {
      if (current()) toast.error(t(sharedTaskErrorKey(error)));
    } finally {
      if (current()) { copyPending.current = false; setCopying(false); }
    }
  };
  const openSharing = () => {
    if (guest && peer) setDialog({ kind: 'leave', sharedTaskId: peer.sharedTaskId, title: session.title, peer: session.deviceLinkDeviceId! });
    else if (hosted) setDialog({ kind: 'close', sharedTaskId: hosted.sharedTaskId, title: session.title });
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
  const item = (key: string, action: () => void, disabled = false) => (
    <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={disabled} onSelect={action}>
      {t(`ccAgent.sidebar.sessionMenu.${key}`)}
    </DropdownMenuItem>
  );
  const separator = <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />;
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
        className={`${MENU_CONTENT_CLASS} min-w-32 overflow-hidden`}
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (dialog) event.preventDefault();
        }}
      >
        {!guest && <>
          {!archived &&
            !empty &&
            item(session.pinnedAt != null ? 'unpin' : 'pin', onPin, ownerActionsBlocked)}
          {item('rename', onRename, ownerActionsBlocked)}
          {move}
          {tags}
          {separator}
          {copy}
        </>}
        {session.status === 'active' && (hosted && !guest ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
              <span className="flex-1">{t('sharedTask.manageSharing')}</span>
              <ChevronRight size={14} className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]" aria-hidden />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={4} className={`${MENU_SUB_CONTENT_CLASS} min-w-40`}>
              <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={copying || writeBlocked}
                onSelect={event => { event.preventDefault(); void copyInvitation(); }}>{t('sharedTask.invite')}</DropdownMenuItem>
              <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={copying}
                onSelect={() => setDialog({ kind: 'manage' })}>{t('sharedTask.manageMembers')}</DropdownMenuItem>
              {separator}
              <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={copying}
                onSelect={openSharing}>{t('sharedTask.cancelSharing')}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem className={MENU_ITEM_CLASS} disabled={!guest && loadingSharing} onSelect={openSharing}>
            {t(guest ? 'sharedTask.leaveShort' : 'sharedTask.title')}
          </DropdownMenuItem>
        ))}
        {!guest && <>
          {exportShare}
          {!archived && !empty && (
            <>
              {separator}
              {item('openInNewWindow', onOpenInNewWindow, ownerActionsBlocked)}
            </>
          )}
          {separator}
          {archived
            ? item('unarchive', onUnarchive, ownerActionsBlocked)
            : !empty && item('archived', onArchive, ownerActionsBlocked)}
          {item('delete', onDelete, ownerActionsBlocked)}
        </>}
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
      {dialog && dialog.kind !== 'manage' && <SharedTaskExitDialog target={dialog}
        onDismiss={dismissSharing} onComplete={dismissSharing} />}
    </div>
  );
}
