import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface NoticeExplainContent {
  title: string;
  summary: string;
  causesTitle: string;
  causes: readonly string[];
  actionsTitle: string;
  actions: readonly string[];
}

/**
 * 统一的「了解原因」浮层入口：
 * - `inline`: 气泡下方轻提示行内嵌（如模型改派、半截失败回复提示）；
 * - `action`: 错误卡片操作区按钮（与「错误详情」并排，不抢主操作）。
 */
export function NoticeExplainPopover({
  content,
  variant = 'inline',
  triggerLabel,
}: {
  content: NoticeExplainContent;
  variant?: 'inline' | 'action';
  triggerLabel?: string;
}) {
  const { t } = useTranslation();
  const label = triggerLabel ?? t('chat.modelMismatch.infoLink');

  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === 'action' ? (
          <Button size="sm" compact tone="quiet" type="button" data-testid="notice-explain-trigger">
            <Info size={12} className="shrink-0" aria-hidden />
            {label}
          </Button>
        ) : (
          <button
            type="button"
            data-testid="notice-explain-trigger"
            className="inline-flex cursor-pointer items-center gap-0.5 rounded px-0.5 text-11 text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <Info size={11} className="shrink-0" aria-hidden />
            <span>{label}</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-24px)] space-y-3 text-12 leading-relaxed"
        data-testid="notice-explain-popover"
      >
        <div className="space-y-1">
          <div className="text-13 font-medium text-[var(--text-primary)]">{content.title}</div>
          <p className="text-[var(--text-secondary)]">{content.summary}</p>
        </div>
        <div className="space-y-1">
          <div className="text-12 font-medium text-[var(--text-primary)]">{content.causesTitle}</div>
          <ul className="list-disc space-y-1 pl-4 text-[var(--text-secondary)]">
            {content.causes.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="space-y-1 border-t border-[var(--border-default)] pt-2.5">
          <div className="text-12 font-medium text-[var(--text-primary)]">{content.actionsTitle}</div>
          <ul className="list-disc space-y-1 pl-4 text-[var(--text-secondary)]">
            {content.actions.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
