/**
 * QuoteChip — 输入框与已发送用户消息共用的紧凑引用胶囊。
 *
 * 默认只展示单行摘要，完整引用与文件来源放在 hover tooltip 中；输入框与
 * 消息气泡复用同一套紧凑尺寸、颜色与截断规则，均不显示关闭按钮。
 */
import { FileText, MessageSquareQuote } from 'lucide-react';
import type { ChatQuote } from '@/lib/chatQuotes';
import { quoteSourceDisplayLabel } from '@/lib/chatQuotes';
import { InlineReferenceChip } from './InlineReferenceChip';

interface QuoteChipProps {
  quote: ChatQuote;
  selected?: boolean;
}

/** 渲染紧凑、不可选中的引用摘要；完整内容仅在 tooltip 中展开。 */
export function QuoteChip({
  quote,
  selected = false,
}: QuoteChipProps) {
  const sourceLabel = quoteSourceDisplayLabel(quote);
  const compactText = quote.text.replace(/\s+/g, ' ').trim();

  const tooltip = (
    <span className="flex flex-col gap-1">
      <span className="whitespace-pre-wrap text-12 leading-[1.5] [overflow-wrap:anywhere]">
        “{quote.text}”
      </span>
      {sourceLabel ? (
        <span
          className="inline-flex min-w-0 items-center gap-1 text-11"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <FileText className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{sourceLabel}</span>
        </span>
      ) : null}
    </span>
  );

  return (
    <InlineReferenceChip
      label={compactText}
      icon={<MessageSquareQuote aria-hidden />}
      tooltip={tooltip}
      tooltipContentClassName="max-h-64 w-80 max-w-[70vw] overflow-y-auto whitespace-normal"
      ariaLabel={quote.text}
      selected={selected}
      // 刻意的例外:chip 上是把换行折叠成单行的**摘要**,不是引用原文。让它进
      // 剪贴板等于把压扁过的文本混进复制结果,原文本身就在被引用的那条消息里。
      // 其余消息内 chip(文件名、会话、项目)展示的是完整实体名,默认可复制。
      textSelectable={false}
    />
  );
}
