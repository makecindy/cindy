import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  taskInboxSection,
  taskInboxSignalsFromRank,
  taskSnoozeUntil,
  type TaskInboxSection,
} from '@cindy/maker-shared/live-task-priority';
import { useActiveFollowUpSessions } from '@/features/scheduler/lib/scheduleSessionBinding';
import type { Session } from '@/lib/ccAgent.types';
import { SessionEntryRows, type SessionEntryRowsProps } from './SessionEntryList';
import { SectionCollapse } from './SectionCollapse';
import { sessionRowKey } from './sessionRowKey';
import {
  sessionPriorityRank,
  sortSessionsForMainList,
  type MainListPriorityContext,
} from '../lib/mainListModel';

type Props = Omit<SessionEntryRowsProps, 'entries'> & {
  sessions: readonly Session[];
  priorityContext: MainListPriorityContext;
};
const SECTIONS: TaskInboxSection[] = ['inbox', 'working', 'snoozed', 'archived'];
export function TaskInbox({ sessions, priorityContext, ...rows }: Props) {
  const { t, i18n } = useTranslation();
  const followingSessions = useActiveFollowUpSessions(sessions);
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
    for (const session of sortSessionsForMainList([...sessions], 'priority', priorityContext)) {
      if (session.status === 'deleted') continue;
      result
        .get(
          taskInboxSection(
            session,
            {
              ...taskInboxSignalsFromRank(sessionPriorityRank(session, priorityContext)),
              following: followingSessions.has(session),
            },
            now,
          ),
        )!
        .push(session);
    }
    result.get('snoozed')!.sort((a, b) => taskSnoozeUntil(a) - taskSnoozeUntil(b));
    return result;
  }, [sessions, priorityContext, now, followingSessions]);
  return (
    <div className="flex flex-col gap-2 pt-1 pl-3">
      {SECTIONS.map((section) => {
        const items = groups.get(section)!;
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
              <span className="ml-auto tabular-nums">{items.length}</span>
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
