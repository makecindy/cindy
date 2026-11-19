import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  INDEFINITE_SNOOZE_UNTIL,
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
import { freezeInboxLayout, snapshotInboxLayout, type FrozenInboxLayout } from './taskInboxPlacement';
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
  /** A teammate's task is listed only while it needs the user or runs. */
  isTeammateTask?: (session: Session) => boolean;
};
const SECTIONS: TaskInboxSection[] = ['inbox', 'working', 'snoozed', 'archived'];

const EMPTY_KEYS: ReadonlySet<string> = new Set();
export function TaskInbox({ sessions, priorityContext, isTeammateTask, ...rows }: Props) {
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
  const [settlement, setSettlement] = useState<{ viewedId?: string; keys: ReadonlySet<string> }>(
    () => ({ viewedId: rows.activeSessionId, keys: EMPTY_KEYS }),
  );
  const settledWhileOpen = settlement.viewedId === rows.activeSessionId ? settlement.keys : EMPTY_KEYS;
  useEffect(() => {
    if (settlement.viewedId !== rows.activeSessionId) {
      setSettlement({ viewedId: rows.activeSessionId, keys: EMPTY_KEYS });
    }
  }, [rows.activeSessionId, settlement.viewedId]);
  const [explicitMoves, setExplicitMoves] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const actionInputs = useRef({ sessions, onAction: rows.onAction, viewedId: rows.activeSessionId });
  actionInputs.current = { sessions, onAction: rows.onAction, viewedId: rows.activeSessionId };
  const handleAction = useCallback(async (id: string, action: Parameters<Props['onAction']>[1]) => {
    const input = actionInputs.current;
    const session = input.sessions.find(session => session.id === id);
    const result = await input.onAction(id, action);
    if (action === 'complete' && result === 'marked-read' && session) {
      const key = sessionRowKey(session);
      if (actionInputs.current.viewedId === input.viewedId) {
        setSettlement(previous => ({
          viewedId: input.viewedId,
          keys: new Set([...(previous.viewedId === input.viewedId ? previous.keys : EMPTY_KEYS), key]),
        }));
      }
      setExplicitMoves(previous => new Set(previous).add(key));
    }
    return result;
  }, []);
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
      const section = taskInboxSection(
        session,
        {
          ...taskInboxSignalsFromRank(
            settledWhileOpen.has(sessionRowKey(session))
              ? sessionNaturalPriorityRank(session, inboxContext)
              : sessionPriorityRank(session, inboxContext),
            sessionNaturalPriorityRank(session, inboxContext),
          ),
          following: followingSessions.has(session),
          teammate: isTeammateTask?.(session) === true,
        },
        now,
      );
      // An idle teammate task stays with the teammate, outside the inbox.
      if (section) result.get(section)!.push(session);
    }
    result.get('snoozed')!.sort((a, b) => taskSnoozeUntil(a) - taskSnoozeUntil(b));
    // The open task moves like any other (a reply sends it to Working at once); its row does not
    // scroll the sidebar after it (useScrollActiveRowIntoView).
    return result;
  }, [sessions, inboxContext, now, followingSessions, isTeammateTask, settledWhileOpen]);
  const rootRef = useRef<HTMLDivElement>(null);
  const hoveredDone = useRef<Element | null>(null);
  const [frozen, setFrozen] = useState<FrozenInboxLayout | null>(null);
  const shown = useMemo(
    () => (frozen ? freezeInboxLayout(groups, sessionRowKey, frozen, explicitMoves) : groups),
    [groups, frozen, explicitMoves],
  );
  useEffect(() => {
    if (!frozen) {
      if (explicitMoves.size) setExplicitMoves(EMPTY_KEYS);
      return;
    }
    const next = snapshotInboxLayout(shown, sessionRowKey);
    if (JSON.stringify([...next]) !== JSON.stringify([...frozen])) setFrozen(next);
    // Consume once it has moved (or disappeared), never turn a past completion
    // into permission for future background reordering during the same hover.
    if (explicitMoves.size) {
      const pending = new Set([...explicitMoves].filter(key => next.get('inbox')?.includes(key)));
      if (pending.size !== explicitMoves.size) setExplicitMoves(pending);
    }
  }, [shown, frozen, explicitMoves]);
  // Removing the hovered button (e.g. completing or archiving its task) can skip mouseout.
  useEffect(() => {
    const button = hoveredDone.current;
    const root = rootRef.current;
    if (!frozen || !button || !root) return;
    const releaseIfRemoved = () => {
      if (hoveredDone.current === button && !button.isConnected) {
        hoveredDone.current = null;
        setFrozen(null);
      }
    };
    releaseIfRemoved();
    const observer = new MutationObserver(releaseIfRemoved);
    observer.observe(root, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, [frozen]);
  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-2 pt-1 pl-3"
      onMouseOver={(event) => {
        const button = event.target instanceof Element && event.target.closest('button[data-inbox-complete]');
        if (button && button !== hoveredDone.current) {
          hoveredDone.current = button;
          setFrozen(snapshotInboxLayout(shown, sessionRowKey));
        }
      }}
      onMouseOut={(event) => {
        if (hoveredDone.current && !(event.relatedTarget instanceof Node && hoveredDone.current.contains(event.relatedTarget))) {
          hoveredDone.current = null;
          setFrozen(null);
        }
      }}
    >
      {SECTIONS.map((section) => {
        // Counts stay live; only the rows hold still while hovering Done.
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
                      onAction={handleAction}
                      inboxMode
                      entries={[{ kind: 'session', session }]}
                      showFirstDivider={false}
                    />
                    {section === 'snoozed' && (
                      <div className="px-3 pb-1 text-11 text-[var(--sidebar-list-muted)]">
                        {session.snoozedUntil === INDEFINITE_SNOOZE_UNTIL
                          ? t('ccAgent.sidebar.inbox.indefinite')
                          : new Date(taskSnoozeUntil(session)).toLocaleString(i18n.language)}
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
