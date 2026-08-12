import { Timer } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import type { MessageAutomationOrigin } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';

/** 自动化来源在 embedded 会话中只展示身份，不拥有跳转主窗口路由的能力。 */
export function AutomationOriginBadge({
  automationOrigin,
}: {
  automationOrigin: MessageAutomationOrigin;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const content = (
    <>
      <Timer size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">
        {automationOrigin.scheduleName
          ? t('chat.userMessage.automationSentNamed', {
              name: automationOrigin.scheduleName,
            })
          : t('chat.userMessage.automationSent')}
      </span>
    </>
  );

  if (navigationMode === 'sidebar-embedded') {
    return (
      <span className="inline-flex max-w-full items-center gap-1 text-11 text-[var(--cmd-palette-item-meta)]">
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-split-pane-route-action=""
      title={t('chat.userMessage.automationViewTask')}
      onClick={() => navigate(scheduleFocusPath(automationOrigin.scheduleId))}
      className={cn(
        'inline-flex max-w-full items-center gap-1 cursor-pointer',
        'text-11 text-[var(--cmd-palette-item-meta)]',
        'hover:text-foreground transition-colors focus:outline-none',
      )}
    >
      {content}
    </button>
  );
}
