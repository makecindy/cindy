import { buildQueueRowPresentation } from '@cindy/maker-shared/queue';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ListEnd, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QueuedMessage } from '@/lib/makerChatStore';
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
  onSteer(clientId: string): Promise<boolean>;
  onRemove(clientId: string): void;
  onMove(clientId: string, targetIndex: number): void;
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
}: PendingQueueBubbleProps) {
  const { t } = useTranslation();
  const presentation = getPendingQueueRowPresentation(entry);
  const editing = editingClientId === entry.clientId;
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
  const body = presentation.isSyntheticTrigger
    ? t(
        presentation.syntheticKind === 'continue'
          ? 'newChat.pendingQueue.syntheticContinueLabel'
          : 'newChat.pendingQueue.syntheticTriggerLabel',
      )
    : presentation.isOrca ||
        presentation.isScheduler ||
        presentation.isSession ||
        presentation.isPlugin
      ? (presentation.rangedSourceText ?? presentation.displayText)
      : entry.chatMessage.content;
  const status = (
    <div className={`flex items-center justify-end gap-1 text-12 text-[var(--text-secondary)] ${simplifiedBotConversation ? "min-h-8" : "min-h-6"}`}>
      {editing ? (
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
              aria-label={t('newChat.pendingQueue.queued')}
            >
              <ListEnd size={14} />
              <span>{t('newChat.pendingQueue.queued')}</span>
              {!busy && <ChevronDown size={12} />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!availability.actions.steer.disabled && (
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
          editing ? <Pencil size={14} /> : sending && statusShown ? <Spinner size={14} /> : null
        }
        simplifiedBotConversation={simplifiedBotConversation}
        pendingEditing={editing}
        pendingActions={status}
      />
    </div>
  );
}
