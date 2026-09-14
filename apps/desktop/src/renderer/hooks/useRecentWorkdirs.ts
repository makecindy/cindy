/**
 * useRecentWorkdirs — 订阅 recentWorkdirsStore,返回当前列表 snapshot。
 *
 * 设计与 useCCSessions 同源:从 store 初始化 snapshot,避免首次 mount 闪空帧;
 * subscribe 在 store 数据变化时触发 setState。
 *
 * 用法:
 *   const { entries } = useRecentWorkdirs();
 *   // entries 按 lastUsedAt desc;归档/删除 session 不影响这个列表。
 */

import { useEffect, useRef, useState } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  recentWorkdirsStore,
  type RecentWorkdirEntry,
} from '@/lib/recentWorkdirsStore';

export interface UseRecentWorkdirsReturn {
  entries: RecentWorkdirEntry[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useRecentWorkdirs(): UseRecentWorkdirsReturn {
  const [snapshot, setSnapshot] = useState<RecentWorkdirEntry[] | null>(() =>
    recentWorkdirsStore.get(),
  );
  const [isLoading, setIsLoading] = useState<boolean>(snapshot === null);
  const [error, setError] = useState<Error | null>(null);
  const hasAnySnapshotRef = useRef(snapshot !== null);
  hasAnySnapshotRef.current = snapshot !== null;

  useEffect(() => {
    const cached = recentWorkdirsStore.get();
    if (cached !== null) {
      setSnapshot(cached);
      setIsLoading(false);
      setError(null);
    } else if (!hasAnySnapshotRef.current) {
      setIsLoading(true);
    }

    const unsub = recentWorkdirsStore.subscribe(() => {
      const next = recentWorkdirsStore.get();
      setSnapshot(next);
      setIsLoading(next === null);
      if (next === null && getDataOwnerGeneration().dataOwnerId !== null) {
        void recentWorkdirsStore
          .ensure()
          .then(() => setError(null))
          .catch((e: unknown) => {
            setError(e instanceof Error ? e : new Error(String(e)));
            setIsLoading(false);
          });
      }
    });

    if (recentWorkdirsStore.get() === null) {
      recentWorkdirsStore
        .ensure()
        .then(() => setError(null))
        .catch((e: unknown) => {
          setError(e instanceof Error ? e : new Error(String(e)));
          // 失败兜底:防止 isLoading 卡死
          setIsLoading(false);
        });
    }
    return unsub;
  }, []);

  return {
    entries: snapshot ?? [],
    isLoading,
    error,
    refresh: () => recentWorkdirsStore.forceRefresh().then(() => undefined),
  };
}
