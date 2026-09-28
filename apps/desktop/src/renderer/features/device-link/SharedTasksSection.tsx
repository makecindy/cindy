import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Crown, FileText, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer, type SharedTaskOwnedItem } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { SessionCard } from '@/features/cc-agent/sidebar/SessionCard';
import { SessionItem } from '@/features/cc-agent/sidebar/SessionItem';
import { sessionActivityMs } from '@/features/cc-agent/lib/dateSessionGrouping';
import type { SessionMoveTarget } from '@/features/cc-agent/sidebar/sessionMoveTarget';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import type { Session } from '@/lib/ccAgent.types';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRemoteProjectSessions, remoteProjectsStore } from './remoteProjectsStore';
import { JoinSharedTaskDialog } from './JoinSharedTaskDialog';
import { sharedTaskErrorKey } from './sharedTaskCompatibility';

/** Uses the existing session mirror; choosing a task must not reconnect or fetch it again. */
const EMPTY_IDS: ReadonlySet<string> = new Set();
const ignoreTaskAction = () => {};
type SharedTaskSessionAction = 'delete' | 'archive' | 'archive-now' | 'unarchive';
type SharedTaskRow = {
  key: string;
  role: 'owned' | 'joined';
  session?: Session;
  owned?: SharedTaskOwnedItem;
  order: number;
};

function sharedTaskActivity(session?: Session): number | null {
  if (!session) return null;
  const activity = sessionActivityMs(session);
  return activity > 0 ? activity : null;
}

interface SharedTasksSectionProps {
  activeSessionId?: string | null;
  localSessions?: readonly Session[];
  runningSessionIds?: ReadonlySet<string>;
  attachedSessionIds?: ReadonlySet<string>;
  notifications?: ReadonlySet<string>;
  onSelect(id: string): void;
  onAction?: (sessionId: string, action: SharedTaskSessionAction, sharedTaskId?: string) => void;
  onRename?: (sessionId: string, title: string) => void;
  onTogglePin?: (sessionId: string, currentlyPinned: boolean) => void;
  onMoveSession?: (sessionId: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
}

export function SharedTasksSection({ activeSessionId, localSessions = [], runningSessionIds = EMPTY_IDS, attachedSessionIds = EMPTY_IDS, notifications = EMPTY_IDS, onSelect, onAction = () => {}, onRename = () => {}, onTogglePin = () => {}, onMoveSession, projectOptions = [] }: SharedTasksSectionProps) {
  const { t } = useTranslation();
  const { mode } = useSidebarMainViewMode();
  const { isAuthenticated, dataOwnerId } = useAuth();
  const generation = getDataOwnerGeneration().generation;
  const sessions = useRemoteProjectSessions();
  const joined = useMemo(() => sessions.filter(session =>
    !!session.deviceLinkDeviceId && isSharedTaskPeer(session.deviceLinkDeviceId)), [sessions]);
  const [collapsed, setCollapsed] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [owned, setOwned] = useState<SharedTaskOwnedItem[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const pending = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    const captured = ++epoch.current;
    const owner = getDataOwnerGeneration();
    setOwned([]); setOpening(null); setJoinOpen(false); pending.current = false;
    if (!isAuthenticated) return;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const items = await window.electronAPI.sharedTask.account({ action: 'owned' }) as SharedTaskOwnedItem[];
        if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) setOwned(items);
      } catch { /* Retain the last confirmed list during transient network failures. */ }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 30_000);
    window.addEventListener('cindy:shared-task-owned-changed', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      epoch.current++; clearInterval(timer);
      window.removeEventListener('cindy:shared-task-owned-changed', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [isAuthenticated, dataOwnerId, generation]);
  const rows = useMemo(() => {
    const result: SharedTaskRow[] = [];
    for (const item of owned) {
      const session = item.local
        ? localSessions.find(candidate => candidate.id === item.sessionId && !candidate.deviceLinkDeviceId)
        : sessions.find(candidate => candidate.id === item.sessionId && candidate.deviceLinkDeviceId === item.hostDeviceId);
      result.push({ key: item.sharedTaskId, role: 'owned', session, owned: item, order: result.length });
    }
    for (const session of joined) {
      result.push({ key: session.id, role: 'joined', session, order: result.length });
    }
    return result.sort((left, right) => {
      const leftActivity = sharedTaskActivity(left.session);
      const rightActivity = sharedTaskActivity(right.session);
      if (leftActivity === null) return rightActivity === null ? left.order - right.order : 1;
      if (rightActivity === null) return -1;
      return rightActivity - leftActivity || left.order - right.order;
    });
  }, [joined, localSessions, owned, sessions]);
  const openOwned = async (item: SharedTaskOwnedItem) => {
    if (item.sessionId === activeSessionId || pending.current) return;
    const owner = getDataOwnerGeneration();
    const captured = epoch.current;
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    pending.current = true; setOpening(item.sharedTaskId);
    try {
      if (!item.local && !sessions.some(session => session.id === item.sessionId && session.deviceLinkDeviceId === item.hostDeviceId)) {
        await window.electronAPI.deviceLink.openLink(item.hostDeviceId);
        if (!current()) return;
        remoteProjectsStore.pinSessionOrigin(item.hostDeviceId, item.sessionId);
      }
      if (current()) onSelect(item.sessionId);
    } catch (error) { if (current()) toast.error(t(sharedTaskErrorKey(error))); }
    finally { if (current()) { pending.current = false; setOpening(null); } }
  };
  const renderTask = (session: Session, onClick: () => void, key: string, navigationOnly: boolean, role: 'owned' | 'joined', sharedTaskId?: string) => {
    const props = {
      session,
      navigationOnly,
      isActive: session.id === activeSessionId,
      isRunning: runningSessionIds.has(session.id),
      isAttached: attachedSessionIds.has(session.id),
      hasAttentionNotification: notifications.has(session.id),
      onClick,
      onAction: navigationOnly
        ? ignoreTaskAction
        : (sessionId: string, action: SharedTaskSessionAction) => onAction(sessionId, action, sharedTaskId),
      onRename: navigationOnly ? ignoreTaskAction : onRename,
      onTogglePin: navigationOnly ? ignoreTaskAction : onTogglePin,
      onMoveSession: navigationOnly ? undefined : onMoveSession,
      projectOptions: navigationOnly ? [] : projectOptions,
      sharedTaskRole: role,
    };
    return mode === 'list'
      ? <SessionCard key={key} {...props} variant="list" />
      : <SessionItem key={key} {...props} />;
  };
  if (!isAuthenticated) return null;
  return <>{(owned.length > 0 || joined.length > 0) && <section className="mx-3 mb-2 border-b border-[var(--border-default)] pb-3" aria-label={t('sharedTask.title')}
    onContextMenu={event => {
      // Task rows handle their own menus; group whitespace must not open the sidebar menu.
      event.preventDefault();
      event.stopPropagation();
    }}>
    <div className="flex min-h-8 items-center justify-between gap-2">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}
        className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
        {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        {t('sharedTask.title')}
      </button>
      <Button variant="secondary" className="w-8 shrink-0 border-transparent bg-transparent p-0" aria-label={t('sharedTask.join')} title={t('sharedTask.join')} onClick={() => setJoinOpen(true)}><Plus size={16} aria-hidden /></Button>
    </div>
    {!collapsed && rows.map(row => {
      if (row.role === 'joined') {
        const session = row.session;
        if (!session) return null;
        return renderTask(session,
          () => { if (session.id !== activeSessionId) onSelect(session.id); }, row.key, true, 'joined');
      }
      const item = row.owned;
      if (!item) return null;
      if (row.session) return <div key={row.key} aria-busy={opening === item.sharedTaskId || undefined}>
        {renderTask(row.session, () => void openOwned(item), row.key, false, 'owned', item.sharedTaskId)}
      </div>;
      // Account discovery can precede the host's session mirror. Keep navigation available
      // without inventing a preview, activity timestamp or Agent identity.
      return <button key={row.key} type="button"
        aria-current={item.sessionId === activeSessionId ? 'page' : undefined} disabled={!!opening} aria-busy={opening === item.sharedTaskId || undefined}
        onClick={() => void openOwned(item)} aria-label={item.title + ', ' + t('sharedTask.roleHost')} title={item.title}
        className={cn('flex w-full items-center gap-2.5 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          mode === 'list' ? 'min-h-14 rounded-lg px-2.5 py-2' : 'h-8 rounded-full pl-3 pr-2',
          item.sessionId === activeSessionId ? 'bg-sidebar-item-active text-sidebar-item-active-foreground' : 'text-foreground hover:bg-sidebar-item-hover')}>
        <span className="flex w-[15px] shrink-0 items-center justify-center">
          <FileText size={12} aria-hidden />
        </span>
        <span className="flex w-3 shrink-0 items-center justify-center" data-testid={`shared-task-role-slot-owned-${item.sessionId}`}>
          <Crown size={12} strokeWidth={1.8} className="text-[var(--warning-fg)]" aria-label={t('sharedTask.roleHost')} />
        </span>
        <span className="truncate">{item.title}</span>
      </button>;
    })}
  </section>}
    <JoinSharedTaskDialog open={joinOpen} onOpenChange={setJoinOpen} />
  </>;
}
