/**
 * 群聊「引用回复」的引用块（docs/product-rules/bot-group-chat.md §10「引用回复」）。
 *
 * 同一个块用在两处：输入框上方的待发引用（可取消，不动正文），以及已发消息里的引用
 * （原消息可定位时点击跳过去）。左侧竖线与 Markdown 引用块同一 token；摘要只占一到两行，
 * 长消息不会撑开时间线。原消息已删除时只显示作者与「原消息已删除」，不再露出快照。
 */
import { Paperclip, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Tip } from '@/components/ui/tooltip';
import { ChatReplyIcon } from '@/components/chat/ChatReplyIcon';
import { cn } from '@/lib/utils';
import type { BotGroupQuoteDisplay } from '../../../shared/botGroupChat';

/** Words for the excerpt line; attachments summarize when the quoted message had no text. */
export function botGroupQuoteSummary(display: BotGroupQuoteDisplay, t: TFunction): string {
  if (display.state === 'deleted') return t('bots.groupChat.quote.deleted');
  if (display.excerpt) return display.excerpt;
  if (!display.attachmentName) return '';
  return display.attachmentCount > 1
    ? t('bots.groupChat.quote.attachments', { name: display.attachmentName, total: display.attachmentCount })
    : display.attachmentName;
}

function QuoteLines({ display, compact }: { display: BotGroupQuoteDisplay; compact: boolean }) {
  const { t } = useTranslation();
  const summary = botGroupQuoteSummary(display, t);
  const attachmentsOnly = display.state !== 'deleted' && !display.excerpt && !!display.attachmentName;
  return (
    <span className={cn('flex min-w-0 flex-1', compact ? 'items-baseline gap-1.5' : 'flex-col')}>
      <span className="min-w-0 shrink-0 truncate text-12 font-medium leading-[1.5] text-[var(--text-secondary)]">
        {compact ? t('bots.groupChat.quote.replyingTo', { name: display.authorName }) : display.authorName}
      </span>
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 text-12 leading-[1.5]',
          display.state === 'deleted' ? 'text-[var(--text-tertiary)]' : 'text-[var(--msg-blockquote-text)]',
        )}
      >
        {attachmentsOnly ? <Paperclip size={12} aria-hidden className="shrink-0" /> : null}
        <span className={cn('min-w-0 break-words [overflow-wrap:anywhere]', compact || attachmentsOnly ? 'truncate' : 'line-clamp-2')}>
          {summary}
        </span>
      </span>
    </span>
  );
}

/**
 * A sent message's quote. With `onLocate` it is a button that goes to the original;
 * without one (deleted original, or a Thread root's quote) it is plain content.
 */
export function BotGroupQuoteBlock({
  display,
  onLocate,
  align = 'left',
}: {
  display: BotGroupQuoteDisplay;
  onLocate?: () => void;
  align?: 'left' | 'right';
}) {
  const { t } = useTranslation();
  const body = (
    <>
      <span aria-hidden className="w-0.5 shrink-0 self-stretch bg-[var(--msg-blockquote-border)]" />
      <QuoteLines display={display} compact={false} />
    </>
  );
  const frame = cn(
    'flex w-full min-w-0 max-w-[480px] select-none gap-2 rounded-lg px-2 py-1 text-left',
    align === 'right' && 'self-end',
  );
  if (!onLocate || display.state === 'deleted') {
    return <div data-testid="bot-group-quote" data-quote-state={display.state} className={frame}>{body}</div>;
  }
  return (
    <button
      type="button"
      data-testid="bot-group-quote"
      data-quote-state={display.state}
      aria-label={t('bots.groupChat.quote.jumpLabel', { name: display.authorName, summary: botGroupQuoteSummary(display, t) })}
      onClick={onLocate}
      className={cn(
        frame,
        'outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      {body}
    </button>
  );
}

/** The quote waiting above the composer. Removing it keeps whatever was typed. */
export function BotGroupQuotePreview({ display, onRemove }: { display: BotGroupQuoteDisplay; onRemove: () => void }) {
  const { t } = useTranslation();
  const removeLabel = t('bots.groupChat.quote.remove');
  return (
    <div data-testid="bot-group-quote-preview" data-quote-state={display.state} className="flex min-w-0 select-none items-center gap-2">
      <ChatReplyIcon size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      <span aria-hidden className="h-4 w-0.5 shrink-0 bg-[var(--msg-blockquote-border)]" />
      <QuoteLines display={display} compact />
      <Tip text={removeLabel}>
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <X size={12} />
        </button>
      </Tip>
    </div>
  );
}
