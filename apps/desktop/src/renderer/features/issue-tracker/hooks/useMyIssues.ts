/**
 * useMyIssues —— /issues 列表的数据源。
 *
 * 进页面拉一次,之后只由用户点刷新触发(**禁** setInterval 轮询;main 侧本身有
 * 60s TTL 缓存,重复进页面不会真去打 GitHub)。刷新期间保留旧数据,拿到新数据再
 * 原子替换,不出现空白帧。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { MyIssuesErrorCode, MyIssuesResult } from '@/../shared/myIssues';
import { createLogger } from '@/lib/logger';

const log = createLogger('useMyIssues');

export interface UseMyIssuesState {
  data: MyIssuesResult | null;
  /** 首屏加载中(有数据后的刷新走 refreshing,不让列表闪成骨架屏)。 */
  loading: boolean;
  refreshing: boolean;
  /**
   * 稳定错误码,不是 main 侧的原始错误文本 —— 后者可能带 userData 绝对路径。
   * UI 只据它选 i18n 文案,不展示原文。
   */
  error: MyIssuesErrorCode | null;
  refresh: () => void;
}

export function useMyIssues(): UseMyIssuesState {
  const [data, setData] = useState<MyIssuesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<MyIssuesErrorCode | null>(null);
  const disposed = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (force) setRefreshing(true);
    try {
      // 切号会让 main 侧把旧账号的结果作废(stale-account-scope),那不是用户该看到的
      // 错误 —— 在同一次调用里按新账号重取。刻意不递归调 load:那样外层 finally 会
      // 清掉内层的 in-flight 标志并提前关掉 loading。上限 2 次,连续切号时不打转。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await window.electronAPI.maker.listMyIssues({ force });
        if (disposed.current) return;
        if (response.success) {
          setData({
            items: response.items,
            githubEnhancement: response.githubEnhancement,
            degraded: response.degraded,
            truncated: response.truncated,
          });
          setError(null);
          return;
        }
        if (response.error === 'stale-account-scope' && attempt === 0) continue;
        // 重试仍撞上切号:按通用错误处理,用户点一次刷新即可。
        setError(response.error === 'stale-account-scope' ? 'unexpected' : response.error);
        return;
      }
    } catch (err) {
      if (disposed.current) return;
      // IPC 层抛错(如来源校验拒绝)只记本地日志,UI 走统一的通用文案。
      log.warn('listMyIssues failed', { error: err instanceof Error ? err.message : String(err) });
      setError('unexpected');
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
