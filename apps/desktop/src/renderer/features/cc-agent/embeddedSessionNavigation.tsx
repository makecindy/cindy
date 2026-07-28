import { createContext, useContext, type ReactNode } from 'react';

/** 会话视图的路由所有权；sidebar-embedded 只展示内容，不拥有窗口路由。 */
export type SessionNavigationMode = 'route-owner' | 'sidebar-embedded';

const SessionNavigationModeContext = createContext<SessionNavigationMode>('route-owner');
const SidebarTargetSessionIdContext = createContext<string | null>(null);
const SidebarPanelHostSessionIdContext = createContext<string | null>(null);

export function SessionNavigationModeProvider({
  mode,
  sidebarTargetSessionId,
  sidebarPanelHostSessionId,
  children,
}: {
  mode: SessionNavigationMode;
  /** 内嵌内容触发 RSB 动作时使用的可见 bucket；不传则沿用内容 session。 */
  sidebarTargetSessionId?: string;
  /**
   * 右栏面板此刻真正显示的那个会话（= 声明了右栏在场的聊天实例的 session）。
   * 只有它的 bucket 打开后用户看得见；内嵌实例不传，表示「本视图里打不开面板」。
   */
  sidebarPanelHostSessionId?: string;
  children: ReactNode;
}) {
  return (
    <SessionNavigationModeContext.Provider value={mode}>
      <SidebarTargetSessionIdContext.Provider value={sidebarTargetSessionId ?? null}>
        <SidebarPanelHostSessionIdContext.Provider value={sidebarPanelHostSessionId ?? null}>
          {children}
        </SidebarPanelHostSessionIdContext.Provider>
      </SidebarTargetSessionIdContext.Provider>
    </SessionNavigationModeContext.Provider>
  );
}

export function useSessionNavigationMode(): SessionNavigationMode {
  return useContext(SessionNavigationModeContext);
}

/**
 * 返回显式可见 RSB bucket；普通会话未注入时回退内容 session。
 * contentSessionId 缺失仍表示调用点没有侧栏动作能力，Provider 只改目标、不负责启用动作。
 */
export function useSidebarTargetSessionId(contentSessionId?: string): string | undefined {
  const sidebarTargetSessionId = useContext(SidebarTargetSessionIdContext);
  if (!contentSessionId) return undefined;
  return sidebarTargetSessionId ?? contentSessionId;
}

/**
 * 「该会话自己的右栏面板此刻打开后用户看得见吗」——面板类入口（后台任务面板等）
 * 的 affordance 判据。
 *
 * 面板按 session 分桶，而右栏一次只显示一个桶：显示哪个桶由「声明了右栏在场的
 * 那个聊天实例」决定（CCAgentSessionView 的 ownsRoute）。内嵌实例（协同 worker
 * 面板、workdir-browse 窄 rail、Orca split 双栏）都不声明在场，往它们自己的桶里
 * 写 tab 只会写进一个用户到不了的桶，点击必然无响应 —— 不给假 affordance
 * （与 BackgroundTasksBody 里非 workflow 行的 isSidebarWindow 守卫同款口径）。
 */
export function useSidebarPanelReachable(contentSessionId?: string): boolean {
  const panelHostSessionId = useContext(SidebarPanelHostSessionIdContext);
  if (!contentSessionId) return false;
  return panelHostSessionId === contentSessionId;
}
