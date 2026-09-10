/**
 * useActiveMainView
 * ---------------------------------------------------------------------------
 * 推导主区域当前激活的 View（任务 / Issues / Plugins / 伙伴），并返回 navigateToView 切换函数。
 *
 * 激活态由 URL 派生：pathname === prefix || pathname.startsWith(prefix + '/')。
 * 当 pathname 不匹配任何 view prefix 时（如 /settings），通常保留最近一次匹配过的 key —
 * 否则 tabbar 会在打开 Settings 等"非 view 页面"时整体失去选中态。插件 `/apps/*`
 * 主视图是例外：它有自己的一级侧边栏入口，因此不沿用 Plugins 的 sticky active。
 *
 * navigateToView 内部做同源去重，避免重复 navigate 触发 FadeSwitcher
 * 不必要的子树重挂载。
 *
 * URL 派生由本 hook 维护；各视图最后位置由账号级 MainViewHistoryProvider 共享，
 * 避免侧栏滚动段卸载后丢失返回位置。未提供 Provider 时使用实例内记忆。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  MainViewHistoryContext,
  type MainViewHistory,
  type MainViewKey,
} from '@/contexts/MainViewHistoryContext';

export type { MainViewKey } from '@/contexts/MainViewHistoryContext';

interface ViewDef {
  key: MainViewKey;
  to: string;
  prefixes: readonly string[];
}

const VIEWS: ViewDef[] = [
  { key: 'cc-agent', to: '/cc-agent', prefixes: ['/cc-agent'] },
  { key: 'issues', to: '/issues', prefixes: ['/issues'] },
  { key: 'plugins', to: '/plugins', prefixes: ['/plugins', '/skillhub'] },
  { key: 'bots', to: '/bots', prefixes: ['/bots'] },
];

const DEFAULT_KEY: MainViewKey = 'cc-agent';

export function useActiveMainView() {
  const location = useLocation();
  const navigate = useNavigate();

  const matchedKey: MainViewKey | null =
    VIEWS.find((view) =>
      view.prefixes.some(
        (prefix) => location.pathname === prefix || location.pathname.startsWith(prefix + '/'),
      ),
    )?.key ?? null;

  // Sticky last-matched key — when path leaves a view (e.g. /settings),
  // keep showing the previously active tab as selected.
  const sharedHistory = useContext(MainViewHistoryContext);
  const localHistory = useRef<MainViewHistory>({
    lastMatchedKey: matchedKey ?? DEFAULT_KEY,
    paths: {},
  });
  const history = sharedHistory ?? localHistory;
  // Per-view last full pathname — switching back to a tab restores its sub-route
  // (e.g. /cc-agent/<sessionId>, /skillhub/local/...) instead of dropping to the bare prefix.
  useEffect(() => {
    if (
      history.current.ignoredLocationKey !== undefined &&
      history.current.ignoredLocationKey === location.key
    ) return;
    if (matchedKey) {
      history.current.lastMatchedKey = matchedKey;
      history.current.paths[matchedKey] = location.pathname + location.search + location.hash;
    }
  }, [history, matchedKey, location.key, location.pathname, location.search, location.hash]);

  const isGhostMainView = location.pathname === '/apps' || location.pathname.startsWith('/apps/');
  const activeKey: MainViewKey | null =
    matchedKey ?? (isGhostMainView ? null : history.current.lastMatchedKey);

  const navigateToView = useCallback(
    (key: MainViewKey) => {
      const view = VIEWS.find((v) => v.key === key);
      if (!view) return;
      if (
        view.prefixes.some(
          (prefix) => location.pathname === prefix || location.pathname.startsWith(prefix + '/'),
        )
      ) {
        return; // 同视图不重复 navigate，与旧 FeatureRail 行为一致
      }
      navigate(history.current.paths[key] ?? view.to);
    },
    [history, location.pathname, navigate],
  );

  return { activeKey, navigateToView };
}
