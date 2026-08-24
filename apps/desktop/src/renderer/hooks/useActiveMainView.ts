/**
 * useActiveMainView
 * ---------------------------------------------------------------------------
 * 推导主区域当前激活的 View（Chat / Issues / Plugins），并返回 navigateToView 切换函数。
 *
 * 激活态由 URL 派生：pathname === prefix || pathname.startsWith(prefix + '/')。
 * 当 pathname 不匹配任何 view prefix 时（如 /settings），通常保留最近一次匹配过的 key —
 * 否则 tabbar 会在打开 Settings 等"非 view 页面"时整体失去选中态。插件 `/apps/*`
 * 主视图是例外：它有自己的一级侧边栏入口，因此不沿用 Plugins 的 sticky active。
 *
 * navigateToView 内部做同源去重，避免重复 navigate 触发 FadeSwitcher
 * 不必要的子树重挂载。
 *
 * URL 派生与最近一次有效 view 的保持语义由本 hook 维护。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export type MainViewKey = 'cc-agent' | 'issues' | 'plugins';

interface ViewDef {
  key: MainViewKey;
  to: string;
  prefixes: readonly string[];
}

const VIEWS: ViewDef[] = [
  { key: 'cc-agent', to: '/cc-agent', prefixes: ['/cc-agent'] },
  { key: 'issues', to: '/issues', prefixes: ['/issues'] },
  { key: 'plugins', to: '/plugins', prefixes: ['/plugins', '/skillhub'] },
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
  const lastMatchedRef = useRef<MainViewKey>(matchedKey ?? DEFAULT_KEY);
  // Per-view last full pathname — switching back to a tab restores its sub-route
  // (e.g. /cc-agent/<sessionId>, /skillhub/local/...) instead of dropping to the bare prefix.
  const lastPathPerViewRef = useRef<Partial<Record<MainViewKey, string>>>({});
  useEffect(() => {
    if (matchedKey) {
      lastMatchedRef.current = matchedKey;
      lastPathPerViewRef.current[matchedKey] = location.pathname + location.search;
    }
  }, [matchedKey, location.pathname, location.search]);

  const isGhostMainView = location.pathname === '/apps' || location.pathname.startsWith('/apps/');
  const activeKey: MainViewKey | null =
    matchedKey ?? (isGhostMainView ? null : lastMatchedRef.current);

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
      navigate(lastPathPerViewRef.current[key] ?? view.to);
    },
    [location.pathname, navigate],
  );

  return { activeKey, navigateToView };
}
