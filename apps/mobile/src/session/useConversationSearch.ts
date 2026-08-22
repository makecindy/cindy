import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { unresponsiveDevicesStore } from '@/device-link/unresponsiveDevicesStore';
import {
  CONVERSATION_SEARCH_LIMIT,
  conversationSearchActiveFilterCount,
  conversationSearchWorkingDirs,
  reconcileConversationSearchProjectSelection,
  searchConversationsAcrossDevices,
  toSearchListItem,
  type ConversationSearchDeviceOrigin,
  type ConversationSearchProjectSelection,
} from '@/session/conversationSearch';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchLastActivityFilter,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '@cindy/maker-shared/conversation-search';
import type { RemoteSessionListItem } from '@/session/sessionList';

export const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

export type ConversationSearchStatus = 'idle' | 'searching' | 'ready';

export function useConversationSearch({
  origins,
  enabled,
  lockedWorkingDirs,
  visibleProjectKeys,
}: {
  origins: readonly ConversationSearchDeviceOrigin[];
  enabled: boolean;
  lockedWorkingDirs?: string[] | null;
  visibleProjectKeys?: readonly string[];
}): {
  query: string;
  setQuery: (value: string) => void;
  status: ConversationSearchStatus;
  results: RemoteSessionListItem[];
  sortBy: ConversationSearchSortBy;
  setSortBy: (value: ConversationSearchSortBy) => void;
  statusFilter: ConversationSearchStatusFilter;
  setStatusFilter: (value: ConversationSearchStatusFilter) => void;
  agentFilter: ConversationSearchAgentFilter;
  setAgentFilter: (value: ConversationSearchAgentFilter) => void;
  lastActivityFilter: ConversationSearchLastActivityFilter;
  setLastActivityFilter: (value: ConversationSearchLastActivityFilter) => void;
  projectSelection: ConversationSearchProjectSelection;
  setProjectSelection: (value: ConversationSearchProjectSelection) => void;
  lockedWorkingDirs: string[] | null;
  activeFilterCount: number;
  resetFilters: () => void;
} {
  const { invoke } = useDeviceLink();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ConversationSearchStatus>('idle');
  const [results, setResults] = useState<RemoteSessionListItem[]>([]);
  const [sortBy, setSortBy] = useState<ConversationSearchSortBy>('relevance');
  const [statusFilter, setStatusFilter] = useState<ConversationSearchStatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState<ConversationSearchAgentFilter>('all');
  const [lastActivityFilter, setLastActivityFilter] =
    useState<ConversationSearchLastActivityFilter>('all');
  const [projectSelection, setProjectSelection] = useState<ConversationSearchProjectSelection>('all');
  const requestSeq = useRef(0);
  const unnamedLabel = t('session.menu.unnamedTitle');
  const originKey = useMemo(
    () => origins.map((origin) => `${origin.deviceId}:${origin.reachable ? '1' : '0'}`).join('|'),
    [origins],
  );
  const visibleKey = visibleProjectKeys?.join('|') ?? '';
  const lockedDirs = useMemo(
    () => (lockedWorkingDirs?.length ? [...lockedWorkingDirs] : null),
    [lockedWorkingDirs?.join('|') ?? ''],
  );

  useEffect(() => {
    if (!visibleProjectKeys) return;
    setProjectSelection((current) => reconcileConversationSearchProjectSelection(current, visibleProjectKeys));
  }, [visibleKey, visibleProjectKeys]);

  const workingDirs = useMemo(
    () => conversationSearchWorkingDirs({
      lockedWorkingDirs: lockedDirs,
      projectSelection,
    }),
    [lockedDirs, projectSelection],
  );
  const activeFilterCount = conversationSearchActiveFilterCount({
    agentKind: agentFilter,
    lastActivity: lastActivityFilter,
    lockedWorkingDirs: lockedDirs,
    projectSelection,
    status: statusFilter,
  });
  const resetFilters = useCallback(() => {
    setStatusFilter('all');
    setAgentFilter('all');
    setLastActivityFilter('all');
    setProjectSelection(lockedDirs ? [...lockedDirs] : 'all');
  }, [lockedDirs]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !trimmed) {
      requestSeq.current += 1;
      setStatus('idle');
      setResults([]);
      return;
    }

    setStatus('searching');
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      void searchConversationsAcrossDevices(
        origins,
        {
          query: trimmed,
          limit: CONVERSATION_SEARCH_LIMIT,
          semanticMode: 'keyword',
          sortBy,
          unnamedLabel,
          filters: {
            agentKind: agentFilter,
            lastActivity: lastActivityFilter,
            status: statusFilter,
            workingDirs,
          },
        },
        {
          invoke,
          getCachedSessions: () => remoteSessionStore.getSessions(),
          isDeviceUnresponsive: (deviceId) => unresponsiveDevicesStore.has(deviceId),
        },
      ).then((page) => {
        if (seq !== requestSeq.current) return;
        const now = Date.now();
        const cachedById = new Map(
          remoteSessionStore.getSessions().map((session) => [session.id, session]),
        );
        setResults(page.results.map((item) => (
          toSearchListItem(item, now, unnamedLabel, cachedById.get(item.session.id))
        )));
        setStatus('ready');
      }).catch(() => {
        if (seq !== requestSeq.current) return;
        setResults([]);
        setStatus('ready');
      });
    }, CONVERSATION_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [
    agentFilter,
    enabled,
    invoke,
    lastActivityFilter,
    originKey,
    origins,
    query,
    sortBy,
    statusFilter,
    unnamedLabel,
    workingDirs,
  ]);

  return {
    query,
    setQuery,
    status,
    results,
    sortBy,
    setSortBy,
    statusFilter,
    setStatusFilter,
    agentFilter,
    setAgentFilter,
    lastActivityFilter,
    setLastActivityFilter,
    projectSelection,
    setProjectSelection,
    lockedWorkingDirs: lockedDirs,
    activeFilterCount,
    resetFilters,
  };
}
