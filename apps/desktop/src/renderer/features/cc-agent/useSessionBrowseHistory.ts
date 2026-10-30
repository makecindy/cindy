/**
 * useSessionBrowseHistory —— 把当前任务视图记进浏览栈,并接上后退/前进。
 *
 * 两个不变量:
 * 1) 游标只在目标路由真的落下后才移动。被 useBlocker / 离开确认拦下的导航不会
 *    留下错位的游标(否则后退键会莫名置灰或跳一项)。
 * 2) 站在栈外页面(草稿、设置…)时,后退先回到最近看过的那个任务,而不是再往前
 *    跳一格 —— 与浏览器从「非历史页」后退的语义一致。
 *
 * `history` / `ownerKey` 只由调用方注入(测试传独立实例;生产用窗口内单例 +
 * 当前账号),不传则退化为单例和空 owner。
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { subscribeRemoteSessionRemoval } from '@/features/device-link/remoteProjectsStore';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { sessionsStore } from '@/lib/sessionsStore';
import {
  sessionBrowseHistory,
  sessionIdFromPathname,
  type SessionBrowseHistory,
} from './sessionBrowseHistory';

export interface SessionBrowseNavigation {
  canBack: boolean;
  canForward: boolean;
  goBack: () => boolean;
  goForward: () => boolean;
}

/** 正在等落地的导航:direction=0 表示「回到游标所在任务」,不移动游标。 */
interface PendingHop {
  direction: -1 | 1 | 0;
  target: string;
}

export interface UseSessionBrowseHistoryOptions {
  history?: SessionBrowseHistory;
  /** 数据所有者键(账号 + 恢复代次);变化时清空栈,避免跨账号串历史。 */
  ownerKey?: string;
}

export function useSessionBrowseHistory(
  options: UseSessionBrowseHistoryOptions = {},
): SessionBrowseNavigation {
  const history = options.history ?? sessionBrowseHistory;
  const location = useLocation();
  const navigate = useNavigate();
  const { ids, index } = useSyncExternalStore(history.subscribe, history.snapshot);
  const sessionId = sessionIdFromPathname(location.pathname);
  const pendingRef = useRef<PendingHop | null>(null);
  const lastPathRef = useRef(location.pathname);

  useEffect(() => {
    if (options.ownerKey !== undefined) history.bindOwner(options.ownerKey);
  }, [history, options.ownerKey]);

  useEffect(() => {
    // 任务被删除时(本窗口或其它窗口的广播都走 sessionsStore.patchLocal)立即摘掉,
    // 后退不会把用户送到一个已经打不开的任务上。
    const offLocal = sessionsStore.subscribePatches((id, patch) => {
      if (patch.status === 'deleted') history.forget(id);
    });
    // 被控端的任务不经过本机 sessionsStore:它们的生命周期只走 remoteProjectsStore
    // 的 applyPatch,删除得再单独订一份,否则远端删掉的任务会留在栈里当死目标。
    const offRemote = subscribeRemoteSessionRemoval((id) => history.forget(id));
    return () => {
      offLocal();
      offRemote();
    };
  }, [history]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending) {
      if (sessionId === pending.target) {
        pendingRef.current = null;
        if (pending.direction !== 0) history.step(pending.direction);
        return;
      }
      // 导航去了别处(被拦下时路由根本不会变,这里不会误清):丢掉这次待提交。
      const pathChanged = location.pathname !== lastPathRef.current;
      lastPathRef.current = location.pathname;
      if (pathChanged) pendingRef.current = null;
    } else {
      lastPathRef.current = location.pathname;
    }
    if (sessionId) history.record(sessionId);
  }, [history, location.pathname, sessionId]);

  const onStack = sessionId !== null && ids[index] === sessionId;
  const go = useCallback(
    (direction: -1 | 1) => {
      const snap = history.snapshot();
      const current = sessionIdFromPathname(location.pathname);
      const onStackNow = current !== null && snap.ids[snap.index] === current;
      if (!onStackNow) {
        // 栈外页面(草稿 / 设置 / 自动任务…):后退只回到最近那个任务。
        if (direction === 1) return false;
        const target = snap.ids[snap.index];
        if (!target) return false;
        pendingRef.current = { direction: 0, target };
        navigate(`/cc-agent/${target}`);
        return true;
      }
      const next = snap.index + direction;
      if (next < 0 || next >= snap.ids.length) return false;
      pendingRef.current = { direction, target: snap.ids[next] };
      navigate(`/cc-agent/${snap.ids[next]}`);
      return true;
    },
    [history, location.pathname, navigate],
  );
  const goBack = useCallback(() => go(-1), [go]);
  const goForward = useCallback(() => go(1), [go]);

  // Windows / Linux 上 mod+[ 在终端里是 ESC(vim / readline)、在 CodeMirror 编辑器里是
  // 缩减/增加缩进(defaultKeymap 的 Mod-[ / Mod-]):焦点落在这两类编辑器内时让给它们,
  // 不做窗口级导航(navigation 会丢掉编辑器里刚改的内容)。mac 的 ⌘[ / ⌘] 在两者中无
  // 原生含义,同一道门一并让路无副作用。
  const outsideOwnedKeyTargets = (event: KeyboardEvent) =>
    !(event.target instanceof Element && event.target.closest('.xterm, .cm-editor'));

  useAppShortcut('session-history-back', (event) => outsideOwnedKeyTargets(event) && goBack());
  useAppShortcut(
    'session-history-forward',
    (event) => outsideOwnedKeyTargets(event) && goForward(),
  );

  return {
    canBack: onStack ? index > 0 : index >= 0,
    canForward: onStack && index >= 0 && index < ids.length - 1,
    goBack,
    goForward,
  };
}
