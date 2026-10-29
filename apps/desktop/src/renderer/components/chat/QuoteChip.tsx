import { FileTypeIcon } from '@/components/ui/file-type-icon';
/**
 * QuoteChip — 输入框与已发送用户消息共用的紧凑引用胶囊。
 *
 * 默认展示单行摘要；点击查看完整原文与评论，草稿还可编辑评论或删除引用。
 */
import { MessageSquareQuote } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { QuoteCommentEditor } from './QuoteCommentEditor';
import type { ChatQuote } from '@/lib/chatQuotes';
import { quoteSourceDisplayLabel } from '@/lib/chatQuotes';
import { InlineReferenceChip } from './InlineReferenceChip';

interface QuoteChipProps {
  quote: ChatQuote;
  /** Static projections and parent-owned links must not gain a nested action. */
  interactive?: boolean;
  selected?: boolean;
  className?: string;
  onEditComment?: (comment: string) => void;
  onDelete?: () => void;
}

/** 草稿和历史共享引用摘要及详情，草稿操作由调用方提供。 */
export function QuoteChip({
  quote,
  interactive = true,
  selected = false,
  className,
  onEditComment,
  onDelete,
}: QuoteChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const sourceLabel = quoteSourceDisplayLabel(quote);
  const compactText = quote.text.replace(/\s+/g, ' ').trim();

  const tooltip = (
    <span className="flex flex-col gap-1">
      <span className="whitespace-pre-wrap text-12 leading-[1.5] [overflow-wrap:anywhere]">
        “{quote.text}”
      </span>
      {quote.comment && <span className="whitespace-pre-wrap text-12 [overflow-wrap:anywhere]">{t('chat.quote.commentLabel')}{quote.comment}</span>}
      {sourceLabel ? (
        <span
          className="inline-flex min-w-0 items-center gap-1 text-11"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <FileTypeIcon name={quote.sourcePath} className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{sourceLabel}</span>
        </span>
      ) : null}
    </span>
  );

  const chip = (
    <InlineReferenceChip
      chipRef={chipRef}
      label={quote.comment ? `${compactText} · ${quote.comment.replace(/\s+/g, ' ')}` : compactText}
      icon={<MessageSquareQuote aria-hidden />}
      tooltip={tooltip}
      tooltipContentClassName="max-h-64 w-80 max-w-[70vw] overflow-y-auto whitespace-normal"
      ariaLabel={[quote.text, quote.comment].filter(Boolean).join('\n')}
      onClick={interactive ? () => setOpen(true) : undefined}
      selected={selected}
      className={className}
      // 刻意的例外:chip 上是把换行折叠成单行的**摘要**,不是引用原文。让它进
      // 剪贴板等于把压扁过的文本混进复制结果,原文本身就在被引用的那条消息里。
      // 其余消息内 chip(文件名、会话、项目)展示的是完整实体名,默认可复制。
      textSelectable={false}
    />
  );
  if (!interactive) return chip;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild><span className="inline-flex min-w-0 max-w-full">{chip}</span></PopoverAnchor>
      <PopoverContent className="w-80 max-w-[calc(100vw-16px)]" onCloseAutoFocus={(event) => {
        event.preventDefault();
        chipRef.current?.focus({ preventScroll: true });
      }}>
        {onEditComment ? <QuoteCommentEditor quote={quote} saveLabel={t('chat.quote.save')}
          onCancel={() => setOpen(false)}
          onSave={(comment) => { onEditComment(comment); setOpen(false); }}
          onDelete={onDelete ? () => { onDelete(); setOpen(false); } : undefined}
        /> : <div className="max-h-80 overflow-auto">{tooltip}</div>}
      </PopoverContent>
    </Popover>
  );
}
