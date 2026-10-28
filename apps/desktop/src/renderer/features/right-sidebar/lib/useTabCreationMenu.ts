import { useContext, useRef, useState, useSyncExternalStore } from 'react';
import { Puzzle } from 'lucide-react';
import { MAIN_VIEW_ICONS } from '@/cindy-brain/mainViewIcons';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { useBotProfiles } from '@/features/bots/botStore';
import { findBotProfileForSession } from '@/features/bots/botSessionOwners';
import { DetachedBotMenuOwnerContext } from '../botMenuOwnerContext';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionWriteBlocked } from '@/features/cc-agent/lib/remoteSessionWriteGuard';
import { sessionsStore } from '@/lib/sessionsStore';
import { listTabKindMenuMetas, useTabKindRegistryVersion } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';
import { canOpenSideChat, openSideChatTab, type SideChatTabPlacement } from './openSideChatTab';
import {
  addGlobalPluginTab, globalTabTitleForGhost, isGlobalTabCapableGhost,
  setActiveGlobalTabId, useGlobalTabs, type PluginViewTabState,
} from '../globalTabs';
import type { TabGroupId } from '../tabGroups';

const BOT_SECONDARY_KINDS = new Set<TabKindId>([
  'review',
  'subagents',
  'background-tasks',
  'terminal',
]);

export interface TabCreationSelectionOptions {
  groupId?: TabGroupId;
  onGlobalTabSelected?: (tabId: string, existed: boolean) => void;
}

export interface TabCreationMenu {
  items: Array<TabKindMenuMeta & {
    disabled: boolean; busy: boolean; group?: 'plugins'; alreadyOpen?: boolean;
  }>;
  select: (kind: TabKindId, options?: TabCreationSelectionOptions) => void;
}

/** Both entry surfaces share the registry, eligibility, pending state and open actions. */
export function useTabCreationMenu({
  sessionId,
  subagentsAvailable,
  onSelect,
  sideChatPlacement,
}: {
  sessionId: string | null | undefined;
  subagentsAvailable: boolean;
  onSelect: (kind: TabKindId) => void;
  sideChatPlacement?: SideChatTabPlacement;
}): TabCreationMenu {
  useTabKindRegistryVersion();
  const installedGhosts = useInstalledGhosts();
  const globalTabs = useGlobalTabs();
  const pluginEntries = installedGhosts.filter(isGlobalTabCapableGhost).map(ghost => {
    const instanceId = installedGhostStoragePart(ghost);
    return {
      kind: `ghost:${instanceId}` as TabKindId,
      instanceId,
      ghost,
      title: globalTabTitleForGhost(ghost),
      icon: MAIN_VIEW_ICONS[ghost.manifest.mainView?.icon ?? 'puzzle'] ?? Puzzle,
      open: globalTabs.some(tab => (tab.state as PluginViewTabState | null)?.instanceId === instanceId),
    };
  }).sort((a, b) => a.title.localeCompare(b.title) || a.instanceId.localeCompare(b.instanceId));
  const bots = useBotProfiles();
  const bot = sessionId ? findBotProfileForSession(bots, sessionId) : undefined;
  const detachedOwner = useContext(DetachedBotMenuOwnerContext);
  const linkedOwner = detachedOwner?.sessionId === sessionId ? detachedOwner : null;
  const isBotSession = Boolean(bot || linkedOwner);
  const localSession = useSyncExternalStore(
    sessionsStore.subscribe,
    () => sessionId ? sessionsStore.findById(sessionId) : null,
  );
  const remoteSessions = useRemoteProjectSessions();
  const session = remoteSessions.find(row => row.id === sessionId) ?? localSession;
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const items = listTabKindMenuMetas().filter(item => {
    if (item.kind.startsWith('ghost:')) return false;
    if (item.kind === 'subagents' && !subagentsAvailable) return false;
    if (item.kind === 'side-chat' && (isBotSession || !canOpenSideChat(session))) return false;
    return !isBotSession || !BOT_SECONDARY_KINDS.has(item.kind);
  }).map(item => {
    const busy = item.kind === 'side-chat' && !!sessionId && openingSessionId === sessionId;
    return {
      ...item,
      busy,
      disabled: !sessionId || !item.enabled || busy
        || (item.kind === 'side-chat' && isRemoteSessionWriteBlocked(session)),
    };
  });

  const select = (kind: TabKindId, options?: TabCreationSelectionOptions) => {
    const plugin = pluginEntries.find(entry => entry.kind === kind);
    if (plugin) {
      const tab = addGlobalPluginTab(plugin.instanceId, {
        ...(options?.groupId && options.groupId !== 'right' ? { groupId: options.groupId } : {}),
        ghost: plugin.ghost,
      });
      if (tab) {
        options?.onGlobalTabSelected?.(tab.id, plugin.open);
        setActiveGlobalTabId(tab.id);
      }
      return;
    }
    if (!sessionId || !items.some(item => item.kind === kind && !item.disabled)) return;
    if (kind === 'side-chat') {
      if (pending.current === sessionId) return;
      pending.current = sessionId;
      setOpeningSessionId(sessionId);
      const opening = openSideChatTab(sessionId, {
        placement: sideChatPlacement,
      });
      void opening.finally(() => {
        if (pending.current === sessionId) pending.current = null;
        setOpeningSessionId(current => current === sessionId ? null : current);
      });
      return;
    }
    onSelect(kind);
  };

  // Keep unavailable future entries last on both surfaces.
  return { items: [
    ...items.filter(item => item.enabled),
    ...pluginEntries.map(entry => ({
      kind: entry.kind, labelKey: 'rightSidebar.tabs.menu.pluginsLabel', labelText: entry.title,
      descriptionKey: 'rightSidebar.tabs.menu.pluginsLabel', icon: entry.icon, order: 0,
      enabled: true, disabled: false, busy: false, group: 'plugins' as const, alreadyOpen: entry.open,
    })),
    ...items.filter(item => !item.enabled),
  ], select };
}
