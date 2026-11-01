import {
  AttachmentCollectionContext,
  type AttachmentCollectionItem,
} from '@/components/chat/AttachmentCollection';
import { attachmentPreviewKind } from '@cindy/maker-shared/attachment-preview';
import { ImageGalleryContext } from '@/components/chat/ImageGalleryContext';
/**
 * 群聊消息的附件（docs/product-rules/bot-group-chat.md §3.1），主群时间线与 Thread 共用。
 *
 * 和任务里用户消息的附件同一套呈现：图片是同款附件图（点开看图器，右键复制 / 定位），
 * 文件是同款 chip（文本预览或交系统应用，右键菜单）。服务器附件还没取到这台电脑时，
 * 在原位置显示「正在加载」或「暂时无法加载」，不让附件悄悄消失，也不把它写回正文。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatImageView } from '@/components/chat/ChatImageView';
import { ImageMissingPlaceholder } from '@/components/chat/ImageMissingPlaceholder';
import { TextLightbox } from '@/components/chat/TextLightbox';
import { UserAttachmentChip } from '@/components/chat/UserAttachmentChip';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { BotGroupAttachment } from '../../../shared/botGroupChat';
import {
  botGroupAttachmentRows,
  type BotGroupAttachmentSlot,
  type BotGroupPendingSlot,
} from './botGroupAttachments';

export function BotGroupMessageAttachments({
  attachments,
  align,
}: {
  attachments: readonly BotGroupAttachment[];
  /** `end` under the user's own bubble; `start` beside an avatar. */
  align: 'start' | 'end';
}) {
  const { t } = useTranslation();
  const [textPreview, setTextPreview] = useState<{ path: string; name: string } | null>(null);
  const chipRef = useRef<HTMLElement | null>(null);
  const rows = botGroupAttachmentRows(attachments);
  if (rows.length === 0) return null;
  const untitled = t('bots.groupChat.files.untitled');
  // Keyed by attachment id in the sent order: an arriving attachment replaces only its own slot.
  const renderSlot = (slot: BotGroupAttachmentSlot) => {
    const name = slot.attachment.name || untitled;
    if (slot.kind === 'image') {
      return (
        <ChatImageView
          key={slot.attachment.id}
          src={slot.url}
          filename={name}
          variant="user-attached"
        />
      );
    }
    if (slot.kind === 'pending') {
      return slot.image ? (
        <ImageMissingPlaceholder
          key={slot.attachment.id}
          filename={name}
          status={slot.state}
          className="w-[280px] max-w-full"
        />
      ) : (
        <PendingAttachmentChip key={slot.attachment.id} state={slot.state} name={name} />
      );
    }
    return (
      <UserAttachmentChip
        key={slot.attachment.id}
        file={{ name, path: slot.path }}
        onOpenTextPreview={(chip) => {
          chipRef.current = chip;
          setTextPreview({ path: slot.path, name });
        }}
      />
    );
  };
  const gallery = rows
    .flatMap((row) => (row.kind === 'picture' ? [row.slot] : row.slots))
    .flatMap((slot) =>
      slot.kind === 'image' ? [{ src: slot.url, galleryId: slot.attachment.id }] : [],
    );
  const collection: AttachmentCollectionItem[] = rows
    .flatMap((row) => (row.kind === 'picture' ? [row.slot] : row.slots))
    .flatMap((slot): AttachmentCollectionItem[] =>
      slot.kind === 'pending'
        ? []
        : [
            {
              id: slot.attachment.id,
              name: slot.attachment.name || untitled,
              source: slot.kind === 'image' ? slot.url : slot.path,
              kind:
                slot.kind === 'image'
                  ? 'image'
                  : attachmentPreviewKind(slot.attachment.name || slot.path),
              media: slot.kind === 'image',
            },
          ],
    );
  return (
    <AttachmentCollectionContext.Provider value={collection}>
      <ImageGalleryContext.Provider value={gallery}>
        <div
          data-testid="bot-group-message-attachments"
          className={cn(
            'flex min-w-0 max-w-full flex-col gap-2',
            align === 'end' ? 'items-end' : 'items-start',
          )}
        >
          {rows.map((row) =>
            row.kind === 'picture' ? (
              renderSlot(row.slot)
            ) : (
              <div
                key={`chips:${row.slots[0]!.attachment.id}`}
                className={cn(
                  'flex max-w-full flex-wrap items-end gap-1.5',
                  align === 'end' ? 'justify-end' : 'justify-start',
                )}
              >
                {row.slots.map(renderSlot)}
              </div>
            ),
          )}
          {textPreview ? (
            <TextLightbox
              filePath={textPreview.path}
              fileName={textPreview.name}
              triggerRef={chipRef}
              onClose={() => setTextPreview(null)}
            />
          ) : null}
        </div>
      </ImageGalleryContext.Provider>
    </AttachmentCollectionContext.Provider>
  );
}

/** A file that is not on this computer yet: the same chip shape, not openable, with its state. */
function PendingAttachmentChip({
  state,
  name,
}: {
  state: BotGroupPendingSlot['state'];
  name: string;
}) {
  const { t } = useTranslation();
  const loading = state === 'loading';
  const status = t(loading ? 'bots.groupChat.files.loading' : 'bots.groupChat.files.unavailable');
  return (
    <span
      role="status"
      aria-label={`${name}, ${status}`}
      title={`${name}, ${status}`}
      data-state={state}
      className={cn(
        'inline-flex h-7 min-w-0 max-w-[min(280px,100%)] items-center gap-1.5 px-2.5 py-1.5',
        'rounded-[9999px] border border-dashed border-[var(--msg-user-border)] bg-[var(--surface-chip)]',
        'text-13 font-medium text-[var(--text-secondary)]',
      )}
    >
      {loading ? (
        <Spinner size={14} aria-hidden="true" className="shrink-0" />
      ) : (
        <FileTypeIcon name={name} size={14} className="shrink-0" />
      )}
      <span className="min-w-0 truncate">{name}</span>
      <span aria-hidden="true" className="shrink-0 font-normal text-[var(--text-tertiary)]">
        {status}
      </span>
    </span>
  );
}
