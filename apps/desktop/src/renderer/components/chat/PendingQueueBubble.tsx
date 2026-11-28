import { buildQueueRowPresentation } from '@cindy/maker-shared/queue';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ListEnd, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QueuedMessage, RemoteQueueDelivery } from '@/lib/makerChatStore';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { getPendingQueueRowPresentation } from '../new-chat/pendingQueueRowPresentation';
import { UserMessage } from './UserMessage';

export interface PendingQueueBubbleProps {
  pluginUi: import('@/cindy-brain/PluginUiContributions').PluginUiMessageCandidates;
  entry: QueuedMessage;
  /** Owning task: remote images in a device-linked task resolve through it. */
  sessionId?: string;
  index: number;
  count: number;
  editingClientId: string | null;
  steeringClientIds: readonly string[];
  editLocks: readonly string[];
  interactionLocks: readonly string[];
  readOnly?: boolean;
  localSend?: boolean;
  simplifiedBotConversation?: boolean;
  onEdit(entry: QueuedMessage): void;
  /** Omitted when the task's engine cannot take input into its running turn: no steer item. */
  onSteer?(clientId: string): Promise<boolean>;
  onRemove(clientId: string): void;
  onMove(clientId: string, targetIndex: number): void;
  onRetryDelivery?(clientId: string): void;
  onDiscardDelivery?(clientId: string, delivery: RemoteQueueDelivery): void;
}

function RemoteQueueStatus({ entry, readOnly, onRetryDelivery, onDiscardDelivery }: Pick<
  PendingQueueBubbleProps, 'entry' | 'readOnly' | 'onRetryDelivery' | 'onDiscardDelivery'
>) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const delivery = entry.remoteDelivery;
  if (!delivery) return null;
  if (delivery.state === 'waiting') {
    return <span>{t('newChat.remoteOutbox.waitingForPrevious')}</span>;
  }
  const unconfirmed = delivery.state === 'unconfirmed';
  const disabled = readOnly || delivery.checking;
  const remove = async () => {
    if (!onDiscardDelivery || disabled) return;
    if (await confirm({
      title: t('newChat.remoteOutbox.deleteConfirmTitle'),
      description: t(unconfirmed ? 'newChat.remoteOutbox.deleteUnconfirmedBody' : 'newChat.remoteOutbox.deleteConfirmBody'),
      confirmText: t('newChat.remoteOutbox.delete'),
      cancelText: t('newChat.remoteOutbox.cancel'),
      confirmVariant: 'destructive',
    })) onDiscardDelivery(entry.clientId, delivery);
  };
  return (
    <div className="flex flex-col items-end gap-1" data-remote-delivery={delivery.state}>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <span>{t(unconfirmed ? 'newChat.remoteOutbox.deliveryUnconfirmed' : 'newChat.remoteOutbox.notSent')}</span>
        <Button size="xs" variant="secondary" tone="quiet" disabled={disabled || !onRetryDelivery} aria-busy={delivery.checking}
          onClick={() => onRetryDelivery?.(entry.clientId)}>
          {t(unconfirmed ? 'newChat.remoteOutbox.recheckDelivery' : 'newChat.remoteOutbox.retry')}
        </Button>
        <Button size="xs" variant="secondary" tone="quiet" disabled={disabled || !onDiscardDelivery} onClick={() => void remove()}>
          {t('newChat.remoteOutbox.delete')}
        </Button>
      </div>
      {delivery.refusal && <span className="text-right">{t(`newChat.remoteOutbox.${delivery.refusal}`)}</span>}
    </div>
  );
}

/** Same full-content bubble as delivered input, with mobile's single queue menu. */
export function PendingQueueBubble({
  pluginUi,
  entry,
  sessionId,
  index,
  count,
  editingClientId,
  steeringClientIds,
  editLocks,
  interactionLocks,
  readOnly,
  localSend,
  simplifiedBotConversation = false,
  onEdit,
  onSteer,
  onRemove,
  onMove,
  onRetryDelivery,
  onDiscardDelivery,
}: PendingQueueBubbleProps) {
  const { t } = useTranslation();
  const presentation = getPendingQueueRowPresentation(entry);
  const editing = editingClientId === entry.clientId;
  const queueStatus = t(entry.waitingForRemoteAccount ? 'newChat.pendingQueue.waitingForDevice' : 'newChat.pendingQueue.queued');
  const sending = entry.isPendingEnqueue || steeringClientIds.includes(entry.clientId);
  const availability = buildQueueRowPresentation({
    item: entry,
    originalIndex: index,
    queueLength: count,
    busy: Boolean(sending),
    readOnlyReason: readOnly ? t('newChat.pendingQueue.regionAria') : null,
    projection: {
      steeringQueueClientIds: steeringClientIds,
      queueEditLocks: editLocks,
      queueInteractionLocks: interactionLocks,
    },
  });
  const busy = Object.values(availability.actions).every((action) => action.disabled);
  const [open, setOpen] = useState(false);
  const sentAt = new Date(entry.chatMessage.createdAt ?? 0).getTime();
  const [statusShown, setStatusShown] = useState(!localSend || Date.now() - sentAt >= 600);
  useEffect(() => {
    if (statusShown) return;
    const timer = setTimeout(() => setStatusShown(true), Math.max(0, sentAt + 600 - Date.now()));
    return () => clearTimeout(timer);
  }, [sentAt, statusShown]);
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);
  const senderLabel =
    presentation.senderLabel ??
    (presentation.isSession
      ? t('newChat.pendingQueue.sessionSenderFallback')
      : presentation.isPlugin
        ? t('newChat.pendingQueue.pluginSenderFallback')
        : null);
  // Plugin attribution can also be stamped by an edit of a composer item. Its
  // chatMessage already has the display body, including ranges for UserMessage.
  const body = presentation.isSyntheticTrigger
    ? t(
        presentation.syntheticKind === 'continue'
          ? 'newChat.pendingQueue.syntheticContinueLabel'
          : 'newChat.pendingQueue.syntheticTriggerLabel',
      )
    : presentation.isOrca || presentation.isScheduler || presentation.isSession
      ? (presentation.rangedSourceText ?? presentation.displayText)
      : entry.chatMessage.content;
  const status = (
    <div className={`flex items-center justify-end gap-1 text-12 text-[var(--text-secondary)] ${simplifiedBotConversation ? "min-h-8" : "min-h-6"}`}>
      {entry.remoteDelivery ? <RemoteQueueStatus entry={entry} readOnly={readOnly}
        onRetryDelivery={onRetryDelivery} onDiscardDelivery={onDiscardDelivery} /> : editing ? (
        <>
          <Pencil size={14} />
          <span>{t('newChat.pendingQueue.editingInComposer')}</span>
        </>
      ) : !statusShown || sending ? null : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className={`flex items-center gap-1 rounded-lg px-1 hover:bg-[var(--surface-hover)] ${simplifiedBotConversation ? "min-h-8" : "min-h-6"}`}
              aria-label={queueStatus}
            >
              <ListEnd size={14} />
              <span>{queueStatus}</span>
              {!busy && <ChevronDown size={12} />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onSteer && !availability.actions.steer.disabled && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  if (!busy) void onSteer(entry.clientId);
                }}
              >
                <ArrowUp size={16} className="shrink-0" />
                {t('newChat.pendingQueue.steerAction')}
              </DropdownMenuItem>
            )}
            {!availability.actions.edit.disabled && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  if (!busy) onEdit(entry);
                }}
              >
                <Pencil size={16} className="shrink-0" />
                {t('newChat.pendingQueue.editAction')}
              </DropdownMenuItem>
            )}
            {!availability.actions.moveUp.disabled && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  if (!busy) onMove(entry.clientId, index - 1);
                }}
              >
                <ArrowUp size={16} className="shrink-0" />
                {t('newChat.pendingQueue.moveUp')}
              </DropdownMenuItem>
            )}
            {!availability.actions.moveDown.disabled && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  if (!busy) onMove(entry.clientId, index + 2);
                }}
              >
                <ArrowDown size={16} className="shrink-0" />
                {t('newChat.pendingQueue.moveDown')}
              </DropdownMenuItem>
            )}
            {!availability.actions.remove.disabled && (
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  if (!busy) onRemove(entry.clientId);
                }}
              >
                <Trash2 size={16} className="shrink-0" />
                {t('newChat.pendingQueue.cancelSend')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  return (
    <div data-pending-queue-message={entry.clientId}>
      {senderLabel && (
        <div className="mb-1 text-right text-12 text-[var(--text-secondary)]">{senderLabel}</div>
      )}
      <UserMessage
        pluginUi={pluginUi}
        {...entry.chatMessage}
        {...(presentation.isSyntheticTrigger
          ? {
              agentReferences: [],
              pastedTextRanges: [],
              slashCommandRanges: [],
              quotesEncoded: false,
            }
          : {})}
        content={body}
        sessionId={sessionId}
        workingDir={entry.createOpts.workingDir ?? ''}
        sourceDevice={entry.sourceDevice ?? entry.chatMessage.sourceDevice}
        sourcePlugin={entry.sourcePlugin ?? entry.chatMessage.sourcePlugin}
        pendingIndicator={
          editing ? <Pencil size={14} /> : sending && statusShown && !entry.remoteDelivery ? <Spinner size={14} /> : null
        }
        simplifiedBotConversation={simplifiedBotConversation}
        pendingEditing={editing}
        pendingActions={status}
      />
    </div>
  );
}
