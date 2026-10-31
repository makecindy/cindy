import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';
import {
  dismissPinSuggestion,
  parseSessionOpenHistory,
  pickPinSuggestion,
  recordSessionOpen,
  type SessionOpenHistory,
} from '../lib/pinSuggestion';

/** 打开历史按账号存在本机(与置顶段折叠等侧栏偏好同一套 owner 隔离)。 */
const OPEN_HISTORY_KEY = 'sidebar.sessionOpenHistory.v1';

function readHistory(ownerId: string | null): SessionOpenHistory {
  return parseSessionOpenHistory(readSidebarOwnerStorage(OPEN_HISTORY_KEY, ownerId));
}

/**
 * 置顶提示:记录当前打开的任务,并从 candidates(侧栏当前可见、未置顶的任务)
 * 里挑出常打开的那一个。计分与去重规则见 lib/pinSuggestion。
 */
export function usePinSuggestion(
  ownerId: string | null,
  openedSessionId: string | undefined,
  candidates: readonly Session[],
): { suggestion: Session | null; dismiss: (sessionId: string) => void } {
  const [history, setHistory] = useState(() => readHistory(ownerId));
  const historyRef = useRef(history);
  const ownerRef = useRef(ownerId);

  const commit = useCallback((next: SessionOpenHistory) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    writeSidebarOwnerStorage(OPEN_HISTORY_KEY, ownerRef.current, JSON.stringify(next));
  }, []);

  useEffect(() => {
    if (ownerRef.current === ownerId) return;
    ownerRef.current = ownerId;
    historyRef.current = readHistory(ownerId);
    setHistory(historyRef.current);
  }, [ownerId]);

  useEffect(() => {
    if (!openedSessionId || !ownerId) return;
    commit(recordSessionOpen(historyRef.current, openedSessionId, Date.now()));
  }, [openedSessionId, ownerId, commit]);

  const dismiss = useCallback(
    (sessionId: string) => commit(dismissPinSuggestion(historyRef.current, sessionId)),
    [commit],
  );

  const suggestion = useMemo(
    () => pickPinSuggestion(history, candidates, Date.now()),
    [history, candidates],
  );

  return { suggestion, dismiss };
}
