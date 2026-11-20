/**
 * CCAgentFeatureLayout
 * ---------------------------------------------------------------------------
 * 普通任务、伙伴私聊与群聊共用任务侧栏和分屏树。切换活动分栏时
 * 保持其余聊天挂载，并把 MainLayout 的工具栏上下文透传给当前视图。
 */

import { useEffect } from 'react';
import { Outlet, useLocation, matchPath, useOutletContext } from 'react-router-dom';

import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { companionChatTarget } from '../bots/companionChatTarget';
import { SplitGroup } from './SplitGroup';
import { useRegisterCCAgentSidebar } from './useRegisterCCAgentSidebar';
import { saveLastChatView, saveLastDocView } from './lib/lastViewStore';

export function CCAgentFeatureLayout() {
  const location = useLocation();
  // 注入 CC Agent 项目/对话侧栏到 Shell 上半槽位(SkillHub / IssueTracker 共用同一 hook)。
  useRegisterCCAgentSidebar();

  useTrackLastView();

  // 透传 MainLayout 下发的 shell context。本层是二级路由 layout（MainLayout →
  // cc-agent → :sessionId），useOutletContext 只读最近一层 Outlet，不在这里透传，
  // 子路由（CCAgentSessionView / OrcaWorkflowRoute / WorkdirBrowseRoute）就拿不到
  // 右栏折叠态 / 切换回调 / 在场声明回调（断链后右栏开关无法工作、面板无法声明在场）。
  const shellContext = useOutletContext<{
    sidebarWidth?: number;
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    /** B2b:工具面板当前贴哪条边(布局树推导),展开入口按此落角。 */
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    /**
     * 把"当前 cc-agent session id"推给 MainLayout,Shell/RSB 据此从 store 拉对应桶的 tab 列表。
     * 仅 CCAgentSessionView 的路由主实例(ownsRoute=true)调用,内嵌实例(workdir-browse rail /
     * OrcaSplitView)不调,避免覆盖主实例声明的 sessionId。
     */
    setRightSidebarSessionId?: (sessionId: string | null) => void;
    /**
     * 把"当前 cc-agent session 的 workingDir"推给 MainLayout,Shell/RSB 注入 plugin ctx,
     * file-browser plugin 据此 useFileTree / useFileContent。空串 = 尚未解析或 remote session。
     * 同 setRightSidebarSessionId,仅主实例调。
     */
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  return (
    <SplitGroup
      activeSessionId={resolveAgentIslandVisibleSessionIdFromPath(location.pathname) ?? companionChatTarget(location.pathname, location.search) ?? undefined}
    >
      <Outlet context={shellContext} />
    </SplitGroup>
  );
}

/**
 * 监听 cc-agent 内部路由切换,把当前位置写入 localStorage,供下次回到
 * /cc-agent 时 CCAgentIndexRedirect 恢复。
 *
 * 命中规则(chat / doc 两个 slot 完全独立,互不覆盖):
 *   - /cc-agent/new                  → chat slot: { kind: 'new' }
 *   - /cc-agent/:sessionId           → chat slot: { kind: 'session', sessionId }
 *   - /cc-agent/files/:sessionId     → doc  slot: { sessionId }
 *   - /cc-agent (index, 等待 redirect) / scheduled / 其它 → 不写
 */
function useTrackLastView(): void {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;

    if (matchPath('/cc-agent/new', path)) {
      saveLastChatView({ kind: 'new' });
      return;
    }

    const filesMatch = matchPath('/cc-agent/files/:sessionId', path);
    if (filesMatch?.params.sessionId) {
      saveLastDocView({ sessionId: filesMatch.params.sessionId });
      return;
    }

    const orcaMatch = matchPath('/cc-agent/orca/:sessionId', path);
    if (orcaMatch?.params.sessionId) {
      saveLastChatView({ kind: 'session', sessionId: orcaMatch.params.sessionId });
      return;
    }

    // /cc-agent/:sessionId — 必须排除已经命中过的静态段（new / scheduled / files /
    // boot）。boot 是副窗启动网关(SecondaryWindowBootGate),只是过渡路由、并非真实
    // session,落它会污染 lastChatView。
    const sessionMatch = matchPath('/cc-agent/:sessionId', path);
    const sid = sessionMatch?.params.sessionId;
    if (sid && sid !== 'new' && sid !== 'scheduled' && sid !== 'files' && sid !== 'boot') {
      saveLastChatView({ kind: 'session', sessionId: sid });
    }
  }, [location.pathname]);
}
