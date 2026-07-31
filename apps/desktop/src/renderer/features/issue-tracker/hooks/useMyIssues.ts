/**
 * useMyIssues —— /issues 列表的数据源。
 *
 * 进页面拉一次,之后只由用户点刷新触发(**禁** setInterval 轮询;main 侧本身有
 * 60s TTL 缓存,重复进页面不会真去打 GitHub)。刷新期间保留旧数据,拿到新数据再
 * 原子替换,不出现空白帧。
 *
 * 首屏先读落盘快照(上次结果),立刻有内容可读 —— 列表要等平台通道与 GitHub 增强都
 * 落地才出得来,实测约 2s,而 service 那层的 TTL 缓存是内存的、冷启动必然 miss。
 *
 * **fresh 与快照分开存**,不要把快照塞进同一个 data:快照里的空列表只说明上次没查到,
 * 不能推出「你从未提交」。空态标题只认这一轮真查过的结果(hasFreshData)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  MyIssuesErrorCode,
  MyIssuesResult,
  MyIssuesSnapshot,
} from '@/../shared/myIssues';
import { createLogger } from '@/lib/logger';

const log = createLogger('useMyIssues');

export interface UseMyIssuesState {
  /** 视图数据:优先本轮 fresh,还没到就用快照顶着。 */
  data: MyIssuesResult | null;
  /**
   * 这一轮是否已经真查过。**空态文案必须看它** —— 快照顶上来的数据不构成
   * 「查证过的空」,false 时不得下任何「有没有 issue」的结论。
   */
  hasFreshData: boolean;
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

/**
 * 把快照补成视图用的 result。缺的三个字段一律填「没问题」——
 * 快照刻意不含本次查询的健康状况,所以缓存态下 notices 自然什么都不显示。
 */
function snapshotAsResult(snapshot: MyIssuesSnapshot): MyIssuesResult {
  return {
    items: snapshot.items,
    githubEnhancement: snapshot.githubEnhancement,
    githubEnhancementFailed: false,
    degraded: null,
    truncated: false,
  };
}

export function useMyIssues(): UseMyIssuesState {
  const [fresh, setFresh] = useState<MyIssuesResult | null>(null);
  const [snapshot, setSnapshot] = useState<MyIssuesSnapshot | null>(null);
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
          setFresh({
            items: response.items,
            githubEnhancement: response.githubEnhancement,
            githubEnhancementFailed: response.githubEnhancementFailed,
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
    // 快照与真实查询**并行发起**,不要 await 它再查:快照只是首屏占位,
    // 让它挡在查询前面等于把最慢那条路又加长一点。
    void (async () => {
      try {
        const cached = await window.electronAPI.maker.getMyIssuesSnapshot();
        // fresh 已经先到就别再拿旧快照盖回去(快照读得慢时会发生)。
        if (!disposed.current && cached) {
          setSnapshot((prev) => prev ?? cached);
        }
      } catch (err) {
        // 读不到快照只是回到「空等几秒」的旧体验,不影响这一页能不能用。
        log.warn('reading the my-issues snapshot failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    void load(false);
    return () => {
      disposed.current = true;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const data = fresh ?? (snapshot ? snapshotAsResult(snapshot) : null);
  return { data, hasFreshData: fresh !== null, loading, refreshing, error, refresh };
}
