import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer, type SharedTaskOwnedItem } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SessionCard } from '@/features/cc-agent/sidebar/SessionCard';
import { SessionItem } from '@/features/cc-agent/sidebar/SessionItem';
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
  const [tab, setTab] = useState<'owned' | 'joined'>('joined');
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
  const both = owned.length > 0 && joined.length > 0;
  const visibleTab = both ? tab : owned.length ? 'owned' : 'joined';
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
  const renderTask = (session: Session, onClick: () => void, key: string, navigationOnly: boolean, sharedTaskId?: string) => {
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
    };
    return mode === 'list'
      ? <SessionCard key={key} {...props} variant="list" />
      : <SessionItem key={key} {...props} />;
  };
  if (!isAuthenticated) return null;
  return <>{(owned.length > 0 || joined.length > 0) && <section className="mx-3 mb-2 border-b border-[var(--border-default)] pb-3" aria-label={t('sharedTask.title')}
    onContextMenu={event => {
      // Shared entries have no context menu; do not open the sidebar's blank-space menu.
      event.preventDefault();
      event.stopPropagation();
    }}>
    <div className="flex min-h-8 items-center justify-between gap-2">
      {both ? <SegmentedControl role="tablist" fullWidth className="min-w-0 flex-1"
        aria-label={t('sharedTask.title')} value={visibleTab} onValueChange={value => { setTab(value); setCollapsed(false); }}
        options={[
          { value: 'owned', label: t('sharedTask.ownedTab') },
          { value: 'joined', label: t('sharedTask.joinedTab') },
        ]} optionClassName="px-1.5" /> : <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}
        className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
        {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        {t(visibleTab === 'owned' ? 'sharedTask.ownedSection' : 'sharedTask.joinedSection')}
      </button>}
      <Button variant="secondary" className="w-8 shrink-0 border-transparent bg-transparent p-0" aria-label={t('sharedTask.join')} title={t('sharedTask.join')} onClick={() => setJoinOpen(true)}><Plus size={16} aria-hidden /></Button>
    </div>
    {(!collapsed || both) && visibleTab === 'owned' && owned.map(item => {
      const session = item.local
        ? localSessions.find(candidate => candidate.id === item.sessionId && !candidate.deviceLinkDeviceId)
        : sessions.find(candidate => candidate.id === item.sessionId && candidate.deviceLinkDeviceId === item.hostDeviceId);
      if (session) return <div key={item.sharedTaskId} aria-busy={opening === item.sharedTaskId || undefined}>
        {renderTask(session, () => void openOwned(item), item.sharedTaskId, false, item.sharedTaskId)}
      </div>;
      // Account discovery can precede the host's session mirror. Keep navigation available
      // without inventing a preview, activity timestamp or Agent identity.
      return <button key={item.sharedTaskId} type="button"
        aria-current={item.sessionId === activeSessionId ? 'page' : undefined} disabled={!!opening} aria-busy={opening === item.sharedTaskId || undefined}
        onClick={() => void openOwned(item)} title={item.title}
        className={cn('flex w-full items-center gap-2.5 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          mode === 'list' ? 'min-h-14 rounded-lg px-2.5 py-2' : 'h-8 rounded-full pl-3 pr-2',
          item.sessionId === activeSessionId ? 'bg-sidebar-item-active text-sidebar-item-active-foreground' : 'text-foreground hover:bg-sidebar-item-hover')}>
        <FileText size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{item.title}</span>
      </button>;
    })}
    {(!collapsed || both) && visibleTab === 'joined' && joined.map(session => renderTask(session,
      () => { if (session.id !== activeSessionId) onSelect(session.id); }, session.id, true))}
  </section>}
    <JoinSharedTaskDialog open={joinOpen} onOpenChange={setJoinOpen} />
  </>;
}
