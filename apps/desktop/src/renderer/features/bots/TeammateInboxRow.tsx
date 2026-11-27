import { useCallback, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TaskInboxSection } from '@cindy/maker-shared/live-task-priority';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { isNestedSessionRowAction, SessionAction, SidebarTitleMarquee } from '@/features/cc-agent/sidebar/SessionItem';
import {
  isSidebarNewWindowActivation,
  openTargetInNewWindow,
  preventMiddleClickAutoscroll,
} from '@/lib/sidebarNewWindowActivation';
import { SessionSnoozeAction, type SnoozeAction } from '@/features/cc-agent/sidebar/SessionSnoozeAction';
import { SidebarRightStatusIndicator } from '@/features/cc-agent/sidebar/SidebarRightStatusIndicator';
import { BotAvatar } from './BotAvatar';
import { companionDragProps } from './companionDragProps';
import { completeTeammateConversation, snoozeTeammateConversation, type TeammateInboxEntry } from './teammateInbox';

const STATUS_KIND = { awaiting: 'awaiting', error: 'error', running: 'running', done: 'done', unread: 'done' } as const;

/**
 * A teammate's main conversation in the inbox, on the task row's geometry (height 32, 18px
 * identity slot, trailing status that gives way to the actions on hover) so the list reads as one.
 * Done only reads the replies; it is offered when that is all the row asks for. A pending request
 * or a failure cannot be dismissed, and a running conversation has nothing to complete.
 */
export function TeammateInboxRow({
  entry,
  section,
  sessionVariant = 'text',
}: {
  entry: TeammateInboxEntry;
  section: TaskInboxSection;
  sessionVariant?: 'text' | 'list';
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isActive = pathname === entry.route || pathname.startsWith(`${entry.route}/`);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const latest = useRef(entry);
  latest.current = entry;
  const snooze = useCallback(async (until: string | null) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      await snoozeTeammateConversation(latest.current, until);
    } catch {
      toast.error(t('ccAgent.sidebar.inbox.snoozeFailed'));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }, [t]);
  const snoozeAction: SnoozeAction = { snooze, saving };
  const canSnooze = entry.snooze !== null;
  const canComplete = section === 'inbox' && (entry.status === 'done' || entry.status === 'unread');
  const hasActions = canSnooze || canComplete;
  const statusKind = entry.status === 'idle' ? null : STATUS_KIND[entry.status];
  const label = [entry.name, entry.deviceLabel, entry.status === 'idle' ? '' : t(`bots.avatarStatus.${entry.status}`)]
    .filter(Boolean).join(' · ');
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      data-teammate-inbox-row={entry.key}
      data-teammate-inbox-route={entry.route}
      // The title marquee listens for hover on a row carrying this marker.
      data-sidebar-navigation-row="true"
      {...companionDragProps(entry.route, entry.name)}
      onMouseDown={(event) => {
        if (!isNestedSessionRowAction(event.target, event.currentTarget)) {
          preventMiddleClickAutoscroll(event);
        }
      }}
      onClick={(event) => {
        if (isNestedSessionRowAction(event.target, event.currentTarget)) return;
        if (isSidebarNewWindowActivation(event)) {
          event.preventDefault();
          void openTargetInNewWindow(entry.route);
          return;
        }
        navigate(entry.route);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || isNestedSessionRowAction(event.target, event.currentTarget)) return;
        event.preventDefault();
        event.stopPropagation();
        void openTargetInNewWindow(entry.route);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        if (isSidebarNewWindowActivation(event)) {
          void openTargetInNewWindow(entry.route);
          return;
        }
        navigate(entry.route);
      }}
      className={cn(
        'group relative flex h-8 w-full cursor-pointer select-none items-center gap-2.5 rounded-full pl-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        sessionVariant === 'list' ? 'pr-2.5' : 'pr-2',
        isActive
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground border border-[var(--sidebar-item-active-border)]'
          : cn('text-foreground hover:bg-sidebar-item-hover', snoozeOpen && 'bg-sidebar-item-hover'),
      )}
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center">
        <BotAvatar bot={entry.bot} size="xs" className="h-[18px] w-[18px] text-10" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <SidebarTitleMarquee title={entry.name} className={isActive ? 'text-sidebar-item-active-foreground' : 'text-foreground'}>
          {entry.name}
        </SidebarTitleMarquee>
        {entry.deviceLabel ? (
          <span className={cn('min-w-0 max-w-[40%] shrink truncate text-xs font-normal',
            isActive ? 'text-sidebar-item-active-foreground/80' : 'text-[var(--sidebar-list-muted)]')}>
            {entry.deviceLabel}
          </span>
        ) : null}
      </span>
      <div className="group/slot relative ml-auto flex h-6 shrink-0 items-center justify-end">
        <div className="grid h-6 grid-cols-[max-content] items-center justify-items-end">
          <div className={cn('col-start-1 row-start-1 flex items-center gap-1 transition-opacity duration-[var(--motion-fast)]',
            hasActions && 'group-hover:w-0 group-hover:overflow-hidden group-hover:opacity-0 group-focus-within/slot:w-0 group-focus-within/slot:overflow-hidden group-focus-within/slot:opacity-0',
            hasActions && snoozeOpen && 'w-0 overflow-hidden opacity-0')}>
            {statusKind ? <SidebarRightStatusIndicator kind={statusKind} isActive={isActive} /> : null}
          </div>
          {hasActions ? (
            <>
              <div aria-hidden className={cn('invisible col-start-1 row-start-1 h-6 items-center gap-0.5',
                snoozeOpen ? 'flex' : 'hidden group-hover:flex group-focus-within/slot:flex')}>
                {canSnooze ? <span className="size-5 shrink-0" /> : null}
                {canComplete ? <span className="size-5 shrink-0" /> : null}
              </div>
              <div className={cn('absolute right-0 top-0 flex h-6 items-center gap-0.5',
                snoozeOpen ? 'opacity-100'
                  : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100')}>
                {canSnooze ? (
                  <SessionSnoozeAction action={snoozeAction} session={entry.snooze!} isActive={isActive} onOpenChange={setSnoozeOpen} />
                ) : null}
                {canComplete ? (
                  <SessionAction inboxComplete label={t('ccAgent.sidebar.inbox.complete')} isActive={isActive}
                    onClick={() => completeTeammateConversation(latest.current)}>
                    <Check size={14} strokeWidth={2} />
                  </SessionAction>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
