import { CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSourceSessionOpener, useSourceSessionTitle } from '@/components/chat/useSourceSessionOpener';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';

import { useSessionNavigationMode } from './embeddedSessionNavigation';

/**
 * 「由哪个任务发起」：另一个任务经 send_to_session 新建本任务时，宿主在任务这一行记下来源任务
 * (sessions.origin_session)。侧栏行只显示一个小标记，悬停说明来源；点这一行仍打开它自己。
 * 标题区常驻「来自「X」」入口，点击回到来源任务。与 Orca Worker、分叉来源互不相干。
 */

function useOriginTitle(session: Session): string | null {
  const origin = session.originSession;
  const live = useSourceSessionTitle(origin?.sessionId, session.id);
  return live ?? origin?.title ?? null;
}

export function SessionOriginRowMark({
  session,
  activeForeground,
}: {
  session: Session;
  activeForeground: boolean;
}) {
  const { t } = useTranslation();
  const title = useOriginTitle(session);
  if (!session.originSession) return null;
  const label = title
    ? t('ccAgent.sessionOrigin.startedByNamed', { name: title })
    : t('ccAgent.sessionOrigin.startedBy');
  return (
    <Tip text={label}>
      <span
        role="img"
        aria-label={label}
        data-session-origin-mark=""
        className={cn(
          'inline-flex size-3 shrink-0 items-center justify-center',
          activeForeground
            ? 'text-[var(--sidebar-item-active-foreground)]'
            : 'text-[var(--cmd-palette-item-meta)]',
        )}
      >
        <CornerDownRight size={11} strokeWidth={2} aria-hidden />
      </span>
    </Tip>
  );
}

export function SessionOriginChip({ session }: { session: Session }) {
  const { t } = useTranslation();
  const navigationMode = useSessionNavigationMode();
  const origin = session.originSession;
  const title = useOriginTitle(session);
  const { open } = useSourceSessionOpener(origin?.sessionId, session.id);
  if (!origin) return null;
  const label = title
    ? t('ccAgent.sessionOrigin.fromNamed', { name: title })
    : t('ccAgent.sessionOrigin.from');
  const interactive = navigationMode !== 'sidebar-embedded' && open !== null;
  const tip = [interactive ? t('ccAgent.sessionOrigin.openSource') : null, label].filter(Boolean).join('\n');
  const className = cn(
    'ml-2 inline-flex min-w-0 max-w-56 shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5',
    'text-11 leading-4 text-[var(--text-secondary)]',
  );
  const content = (
    <>
      <CornerDownRight size={12} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <Tip text={tip}>
      {interactive ? (
        <button
          type="button"
          data-session-origin-chip=""
          aria-label={`${t('ccAgent.sessionOrigin.openSource')}: ${label}`}
          onClick={open ?? undefined}
          className={cn(className, 'cursor-pointer transition-colors hover:bg-titlebar-button-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]')}
          style={WINDOW_NO_DRAG_STYLE}
        >
          {content}
        </button>
      ) : (
        <span role="note" data-session-origin-chip="" aria-label={label} className={className} style={WINDOW_NO_DRAG_STYLE}>
          {content}
        </span>
      )}
    </Tip>
  );
}
