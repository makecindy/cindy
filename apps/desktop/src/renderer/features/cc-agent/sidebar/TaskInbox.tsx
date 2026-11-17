import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  taskInboxSection,
  taskInboxSignalsFromRank,
  taskSnoozeUntil,
  type TaskInboxSection,
} from '@cindy/maker-shared/live-task-priority';
import {
  getRemoteSessionActivity,
  useRemoteSessionActivityRevision,
} from '@/features/device-link/remoteSessionActivityStore';
import { useActiveFollowUpSessions } from '@/features/scheduler/lib/scheduleSessionBinding';
import type { Session } from '@/lib/ccAgent.types';
import { SessionEntryRows, type SessionEntryRowsProps } from './SessionEntryList';
import { SectionCollapse } from './SectionCollapse';
import { sessionRowKey } from './sessionRowKey';
import {
  freezeInboxLayout,
  holdViewedInboxPlacement,
  snapshotInboxLayout,
  type FrozenInboxLayout,
  type ViewedInboxPlacement,
} from './taskInboxPlacement';
import {
  sessionNaturalPriorityRank,
  sessionPriorityRank,
  sortSessionsForMainList,
  type MainListPriorityContext,
} from '../lib/mainListModel';
import { sidebarPriorityContext } from '../lib/sidebarPriorityContext';

type Props = Omit<SessionEntryRowsProps, 'entries'> & {
  sessions: readonly Session[];
  priorityContext: MainListPriorityContext;
};
const SECTIONS: TaskInboxSection[] = ['inbox', 'working', 'snoozed', 'archived'];
export function TaskInbox({ sessions, priorityContext, ...rows }: Props) {
  const { t, i18n } = useTranslation();
  const followingSessions = useActiveFollowUpSessions(sessions);
  // The inbox spans more tasks than the regular list (e.g. outside its status filter), so remote
  // running / unread / waiting phases are read for every inbox task, not only the list's scope.
  const remoteActivityRevision = useRemoteSessionActivityRevision();
  const inboxContext = useMemo(
    () => sidebarPriorityContext(priorityContext, sessions,
      (session) => getRemoteSessionActivity(session.id, session.deviceLinkDeviceId)?.phase),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteActivityRevision 代表整表远程活动
    [priorityContext, sessions, remoteActivityRevision],
  );
  const { activeSessionId } = rows;
  const viewedPlacement = useRef<ViewedInboxPlacement | null>(null);
  const [now, setNow] = useState(Date.now);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(['working', 'snoozed', 'archived']),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Only the nearest expiry needs a timer; a focus reconciles time after sleep.
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const next = Math.min(...sessions.map(taskSnoozeUntil).filter((at) => at > now));
    const timer = Number.isFinite(next)
      ? setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, next - Date.now())))
      : undefined;
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [sessions, now]);
  const groups = useMemo(() => {
    const result = new Map<TaskInboxSection, Session[]>(SECTIONS.map((key) => [key, []]));
    for (const session of sortSessionsForMainList([...sessions], 'priority', inboxContext)) {
      if (session.status === 'deleted') continue;
      result
        .get(
          taskInboxSection(
            session,
            {
              ...taskInboxSignalsFromRank(
                sessionPriorityRank(session, inboxContext),
                sessionNaturalPriorityRank(session, inboxContext),
              ),
              following: followingSessions.has(session),
            },
            now,
          ),
        )!
        .push(session);
    }
    result.get('snoozed')!.sort((a, b) => taskSnoozeUntil(a) - taskSnoozeUntil(b));
    const viewed = sessions.find((session) => session.id === activeSessionId);
    viewedPlacement.current = holdViewedInboxPlacement(
      result, sessionRowKey, viewed ? sessionRowKey(viewed) : undefined, viewedPlacement.current,
    );
    return result;
  }, [sessions, inboxContext, now, followingSessions, activeSessionId]);
  // While the pointer is over the list (or a row menu / snooze popover it opened is still open),
  // rows keep their arrangement so a one-click Done never lands on a row that just moved.
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const [frozen, setFrozen] = useState<FrozenInboxLayout | null>(null);
  const shown = useMemo(
    () => (frozen ? freezeInboxLayout(groups, sessionRowKey, frozen) : groups),
    [groups, frozen],
  );
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const root = rootRef.current;
    if (!frozen || !root) return;
    const release = () => {
      if (!pointerInside.current && !root.querySelector('[data-state="open"]')) setFrozen(null);
    };
    const observer = new MutationObserver(release);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    return () => observer.disconnect();
  }, [frozen]);
  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-2 pt-1 pl-3"
      onPointerEnter={() => {
        pointerInside.current = true;
        setFrozen((current) => current ?? snapshotInboxLayout(shownRef.current, sessionRowKey));
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        if (!rootRef.current?.querySelector('[data-state="open"]')) setFrozen(null);
      }}
    >
      {SECTIONS.map((section) => {
        // Counts stay live; only the rows hold still while the pointer is over the list.
        const count = groups.get(section)!.length;
        const items = shown.get(section)!;
        const closed = collapsed.has(section);
        const visible = expanded.has(section) ? items : items.slice(0, 20);
        return (
          <section key={section}>
            <button
              type="button"
              aria-expanded={!closed}
              className="flex h-8 w-full items-center gap-1.5 rounded-full px-2 text-xs text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover"
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(section)) next.delete(section);
                  else next.add(section);
                  return next;
                })
              }
            >
              {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span>{t(`ccAgent.sidebar.inbox.${section}`)}</span>
              <span className="ml-auto tabular-nums">{count}</span>
            </button>
            <SectionCollapse collapsed={closed}>
              {section === 'inbox' && items.length === 0 && (
                <p className="px-3 py-3 text-xs text-[var(--sidebar-list-muted)]">
                  {t('ccAgent.sidebar.inbox.empty')}
                </p>
              )}
              {visible.map((session) => (
                <div key={sessionRowKey(session)} className="w-full">
                  <div className="min-w-0 flex-1">
                    <SessionEntryRows
                      {...rows}
                      inboxMode
                      entries={[{ kind: 'session', session }]}
                      showFirstDivider={false}
                    />
                    {section === 'snoozed' && (
                      <div className="px-3 pb-1 text-11 text-[var(--sidebar-list-muted)]">
                        {new Date(taskSnoozeUntil(session)).toLocaleString(i18n.language)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {visible.length < items.length && (
                <button
                  type="button"
                  className="h-7 w-full rounded-full text-xs text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover"
                  onClick={() => setExpanded((previous) => new Set(previous).add(section))}
                >
                  {t('ccAgent.sidebar.showAllSessions', { count: items.length })}
                </button>
              )}
            </SectionCollapse>
          </section>
        );
      })}
    </div>
  );
}
