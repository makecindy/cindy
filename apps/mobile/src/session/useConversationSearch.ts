import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { unresponsiveDevicesStore } from '@/device-link/unresponsiveDevicesStore';
import {
  CONVERSATION_SEARCH_LIMIT,
  conversationSearchActiveFilterCount,
  conversationSearchWorkingDirs,
  reconcileConversationSearchProjectSelection,
  scopedConversationSearchOrigins,
  searchConversationsAcrossDevices,
  cachedSessionForSearchResult,
  conversationSearchSessionCacheKey,
  toSearchListItem,
  type ConversationSearchDeviceOrigin,
  type ConversationSearchListItem,
  type ConversationSearchProjectOption,
  type ConversationSearchProjectSelection,
} from '@/session/conversationSearch';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchLastActivityFilter,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '@cindy/maker-shared/conversation-search';

export const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

export type ConversationSearchStatus = 'idle' | 'searching' | 'ready';

export function useConversationSearch({
  origins,
  enabled,
  lockedWorkingDirs,
  projects,
}: {
  origins: readonly ConversationSearchDeviceOrigin[];
  enabled: boolean;
  lockedWorkingDirs?: string[] | null;
  projects?: readonly ConversationSearchProjectOption[];
}): {
  query: string;
  setQuery: (value: string) => void;
  status: ConversationSearchStatus;
  results: ConversationSearchListItem[];
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
  const [results, setResults] = useState<ConversationSearchListItem[]>([]);
  const [sortBy, setSortBy] = useState<ConversationSearchSortBy>('relevance');
  const [statusFilter, setStatusFilter] = useState<ConversationSearchStatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState<ConversationSearchAgentFilter>('all');
  const [lastActivityFilter, setLastActivityFilter] =
    useState<ConversationSearchLastActivityFilter>('all');
  const [projectSelection, setProjectSelection] = useState<ConversationSearchProjectSelection>('all');
  const requestSeq = useRef(0);
  const unnamedLabel = t('session.menu.unnamedTitle');
  const visibleProjectKeys = useMemo(
    () => (projects ?? []).map((project) => project.key),
    [projects],
  );
  const visibleKey = visibleProjectKeys.join('|');
  const lockedDirs = useMemo(
    () => (lockedWorkingDirs?.length ? [...lockedWorkingDirs] : null),
    [lockedWorkingDirs?.join('|') ?? ''],
  );
  const scopedOrigins = useMemo(
    () => (lockedDirs ? [...origins] : scopedConversationSearchOrigins(origins, projectSelection, projects ?? [])),
    [lockedDirs, origins, projectSelection, projects],
  );
  const originKey = useMemo(
    () => scopedOrigins.map((origin) => (
      `${origin.deviceId}:${origin.reachable ? '1' : '0'}:${(origin.workingDirs ?? []).join(',')}`
    )).join('|'),
    [scopedOrigins],
  );

  useEffect(() => {
    if (!projects) return;
    setProjectSelection((current) => reconcileConversationSearchProjectSelection(current, visibleProjectKeys));
  }, [projects, visibleKey, visibleProjectKeys]);

  const workingDirs = useMemo(
    () => conversationSearchWorkingDirs({ lockedWorkingDirs: lockedDirs }),
    [lockedDirs],
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
    setProjectSelection('all');
  }, []);

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
        scopedOrigins,
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
        const cachedByKey = new Map(
          remoteSessionStore.getSessions().map((session) => [
            conversationSearchSessionCacheKey(session),
            session,
          ]),
        );
        setResults(page.results.map((item) => (
          toSearchListItem(item, now, unnamedLabel, cachedSessionForSearchResult(item, cachedByKey))
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
    scopedOrigins,
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
