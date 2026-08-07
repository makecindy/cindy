import { createContext, useContext, type ReactNode } from 'react';

/** 会话视图的路由所有权；sidebar-embedded 只展示内容，不拥有窗口路由。 */
export type SessionNavigationMode = 'route-owner' | 'sidebar-embedded' | 'split-pane';

const SessionNavigationModeContext = createContext<SessionNavigationMode>('route-owner');
export type SessionNavigationIntentReporter = (
  targetSessionId: string,
  routeOwnerSessionId?: string,
) => void;
const SessionNavigationIntentContext = createContext<SessionNavigationIntentReporter | null>(null);
const SidebarTargetSessionIdContext = createContext<string | null>(null);
const SidebarPanelHostSessionIdContext = createContext<string | null>(null);

export function SessionNavigationModeProvider({
  mode,
  onSessionNavigate,
  sidebarTargetSessionId,
  sidebarPanelHostSessionId,
  children,
}: {
  mode: SessionNavigationMode;
  /** 分屏 pane 在真正改路由前上报目标任务，供 SplitGroup 选择被替换的来源 pane。 */
  onSessionNavigate?: SessionNavigationIntentReporter;
  /** 内嵌内容触发 RSB 动作时使用的可见 bucket；不传则沿用内容 session。 */
  sidebarTargetSessionId?: string;
  /**
   * 当前子树的面板动作可以到达的会话 bucket。路由主实例的 bucket 已在场；可见
   * split pane 会在点击前接管路由，因此自己的 bucket 也可达。其它内嵌实例不传，
   * 表示「本视图里打不开该面板」。
   */
  sidebarPanelHostSessionId?: string;
  children: ReactNode;
}) {
  return (
    <SessionNavigationModeContext.Provider value={mode}>
      <SessionNavigationIntentContext.Provider value={onSessionNavigate ?? null}>
        <SidebarTargetSessionIdContext.Provider value={sidebarTargetSessionId ?? null}>
          <SidebarPanelHostSessionIdContext.Provider value={sidebarPanelHostSessionId ?? null}>
            {children}
          </SidebarPanelHostSessionIdContext.Provider>
        </SidebarTargetSessionIdContext.Provider>
      </SessionNavigationIntentContext.Provider>
    </SessionNavigationModeContext.Provider>
  );
}

export function useSessionNavigationMode(): SessionNavigationMode {
  return useContext(SessionNavigationModeContext);
}

/** 在组件调用 navigate 前记录目标任务；普通路由与 sidebar-embedded 默认无需处理。 */
export function useSessionNavigationIntent(): SessionNavigationIntentReporter | null {
  return useContext(SessionNavigationIntentContext);
}

export function isInteractiveSessionNavigationMode(mode: SessionNavigationMode): boolean {
  return mode !== 'sidebar-embedded';
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
 * 「该会话自己的右栏面板通过当前交互能否到达」——面板类入口（后台任务面板等）
 * 的 affordance 判据。
 *
 * 面板按 session 分桶，而右栏一次只显示一个桶：显示哪个桶由「声明了右栏在场的
 * 那个聊天实例」决定。路由主实例当前可达；可见 split pane 会先接管路由再显示
 * 自己的 bucket。其它内嵌实例（协同 worker 面板、workdir-browse 窄 rail、Orca
 * split 双栏）都不可达，往它们自己的桶里写 tab 只会写进用户到不了的桶，点击
 * 必然无响应 —— 不给假 affordance
 * （与 BackgroundTasksBody 里非 workflow 行的 isSidebarWindow 守卫同款口径）。
 */
export function useSidebarPanelReachable(contentSessionId?: string): boolean {
  const panelHostSessionId = useContext(SidebarPanelHostSessionIdContext);
  if (!contentSessionId) return false;
  return panelHostSessionId === contentSessionId;
}
