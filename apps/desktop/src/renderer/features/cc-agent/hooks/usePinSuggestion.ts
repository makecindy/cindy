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
 *
 * 多个窗口(主窗口与任务副窗口)各自挂着侧栏、共用同一份存储:每次改动都在同源
 * 跨窗口的 Web Lock 内「读最新记录 → 合并 → 写回」,两个窗口同时改也会排队执行;
 * 再监听其它窗口的写入刷新本窗口。避免一个窗口用旧记录覆盖另一个窗口刚记下的
 * 「不再提示」。
 */
export function usePinSuggestion(
  ownerId: string | null,
  openedSessionId: string | undefined,
  candidates: readonly Session[],
): { suggestion: Session | null; dismiss: (sessionId: string) => void } {
  const [history, setHistory] = useState(() => readHistory(ownerId));
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;

  const update = useCallback((change: (latest: SessionOpenHistory) => SessionOpenHistory) => {
    const apply = () => {
      const latest = readHistory(ownerRef.current);
      const next = change(latest);
      if (next !== latest) {
        writeSidebarOwnerStorage(OPEN_HISTORY_KEY, ownerRef.current, JSON.stringify(next));
      }
      setHistory(next);
    };
    // Electron 渲染进程都有 navigator.locks;没有时(测试环境)直接执行。
    if (typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks.request(OPEN_HISTORY_KEY, apply);
    } else {
      apply();
    }
  }, []);

  useEffect(() => {
    setHistory(readHistory(ownerId));
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(OPEN_HISTORY_KEY)) setHistory(readHistory(ownerRef.current));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [ownerId]);

  useEffect(() => {
    if (!openedSessionId || !ownerId) return;
    update((latest) => recordSessionOpen(latest, openedSessionId, Date.now()));
  }, [openedSessionId, ownerId, update]);

  const dismiss = useCallback(
    (sessionId: string) => update((latest) => dismissPinSuggestion(latest, sessionId)),
    [update],
  );

  const suggestion = useMemo(
    () => pickPinSuggestion(history, candidates, Date.now()),
    [history, candidates],
  );

  return { suggestion, dismiss };
}
