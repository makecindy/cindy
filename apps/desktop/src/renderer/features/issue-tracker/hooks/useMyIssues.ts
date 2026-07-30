/**
 * useMyIssues —— /issues 列表的数据源。
 *
 * 进页面拉一次,之后只由用户点刷新触发(**禁** setInterval 轮询;main 侧本身有
 * 60s TTL 缓存,重复进页面不会真去打 GitHub)。刷新期间保留旧数据,拿到新数据再
 * 原子替换,不出现空白帧。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { MyIssuesResult } from '@/../shared/myIssues';
import { createLogger } from '@/lib/logger';

const log = createLogger('useMyIssues');

export interface UseMyIssuesState {
  data: MyIssuesResult | null;
  /** 首屏加载中(有数据后的刷新走 refreshing,不让列表闪成骨架屏)。 */
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMyIssues(): UseMyIssuesState {
  const [data, setData] = useState<MyIssuesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disposed = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (force) setRefreshing(true);
    try {
      const response = await window.electronAPI.maker.listMyIssues({ force });
      if (disposed.current) return;
      if (!response.success) {
        setError(response.error);
        return;
      }
      setData({
        items: response.items,
        githubEnhancement: response.githubEnhancement,
        degraded: response.degraded,
        truncated: response.truncated,
      });
      setError(null);
    } catch (err) {
      if (disposed.current) return;
      const message = err instanceof Error ? err.message : String(err);
      log.warn('listMyIssues failed', { error: message });
      setError(message);
    } finally {
      inFlight.current = false;
      if (!disposed.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    void load(false);
    return () => {
      disposed.current = true;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { data, loading, refreshing, error, refresh };
}
