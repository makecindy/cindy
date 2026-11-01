/**
 * PinSuggestionHint — 置顶段下方的一行置顶提示(何时出现见 lib/pinSuggestion)。
 * 全灰阶,不引入新颜色;「置顶」走与右键菜单同一个置顶入口,× 之后不再提示该任务。
 */

import { Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { getSessionDisplayTitle } from '../lib/sessionDisplayTitle';

export function PinSuggestionHint({
  session,
  onPin,
  onDismiss,
}: {
  session: Session;
  onPin: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const title = getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'), t);
  const dismissLabel = t('ccAgent.sidebar.pinSuggestionDismiss');
  const text = t('ccAgent.sidebar.pinSuggestion', { title });

  return (
    <div className="flex h-7 items-center gap-1.5 pr-3 pl-6 text-xs text-sidebar-muted select-none">
      <Pin size={12} strokeWidth={2} className="shrink-0 text-sidebar-action-icon" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button
        type="button"
        onClick={() => onPin(session.id)}
        className={cn(
          'h-5 shrink-0 rounded-full px-2 text-xs font-medium text-foreground',
          'transition-colors hover:bg-sidebar-item-hover',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        {t('ccAgent.sidebar.sessionMenu.pin')}
      </button>
      <Tip text={dismissLabel} side="bottom">
        <button
          type="button"
          onClick={() => onDismiss(session.id)}
          aria-label={dismissLabel}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            'text-sidebar-action-icon transition-colors hover:bg-sidebar-item-hover',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </Tip>
    </div>
  );
}
