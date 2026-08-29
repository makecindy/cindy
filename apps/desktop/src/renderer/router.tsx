import { createHashRouter, Navigate } from 'react-router-dom';

import { MainLayout } from '@/components/layout/MainLayout';
import { RouteErrorFallback } from '@/components/error/RouteErrorFallback';
import { SidebarWindowLayout } from '@/components/layout/SidebarWindowLayout';
import { GhostPanelWindowLayout } from '@/components/layout/GhostPanelWindowLayout';
import { SettingsView } from '@/components/settings/SettingsView';
import { LoginPage } from '@/components/login/LoginPage';
import { AddAccountLoginPage } from '@/components/login/AddAccountLoginPage';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { GuestRoute } from '@/components/auth/GuestRoute';
import { LocalDbGate } from '@/components/auth/LocalDbGate';
import { CCAgentFeatureLayout } from '@/features/cc-agent/CCAgentFeatureLayout';
import { CCAgentIndexRedirect } from '@/features/cc-agent/CCAgentIndexRedirect';
import { SecondaryWindowBootGate } from '@/features/cc-agent/SecondaryWindowBootGate';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import { NewMakerDraftRoute } from '@/features/cc-agent/NewMakerDraftRoute';
import { OrcaWorkflowRoute } from '@/features/cc-agent/OrcaWorkflowRoute';
import { WorkdirBrowseRoute } from '@/features/cc-agent/workdir-browse/WorkdirBrowseRoute';
import { IssueTrackerFeatureLayout } from '@/features/issue-tracker/IssueTrackerFeatureLayout';
import { SkillhubFeatureLayout } from '@/features/skillhub/SkillhubFeatureLayout';
import { SkillhubHomeView } from '@/features/skillhub/SkillhubHomeView';
import { SkillhubDetailView } from '@/features/skillhub/SkillhubDetailView';
import { SkillhubMarketListView } from '@/features/skillhub/SkillhubMarketListView';
import { MakerExperimentalView } from '@/features/maker-experimental/MakerExperimentalView';
import { SchedulerPage } from '@/features/scheduler';
import { GhostPluginPage } from '@/features/plugin/GhostPluginPage';
import { GhostMainViewFeatureLayout } from '@/features/plugin/GhostMainViewFeatureLayout';

/**
 * 三层路由架构：
 *
 *   GuestRoute (未登录)
 *    └── /login                    → LoginPage
 *
 *   ProtectedRoute (已登录) — 校验 canEnterApp（真登出或换号窗口）
 *    └── LocalDbGate               → 等 localDb.ensureReady（按 userId 切库）
 *         └── MainLayout            → 主功能区
 *              ├── /                → Navigate to /cc-agent
 *              ├── /cc-agent/...    → CCAgentFeatureLayout
 *              └── /settings        → SettingsView
 *
 * LocalDbGate 下沉在路由层：AuthProvider 在 RouterProvider 之外无法 useNavigate。
 */
export const router = createHashRouter([
  {
    path: '/login',
    element: <GuestRoute />,
    // 登录线渲染崩溃时的全屏兜底(没有它 react-router 会渲染开发者默认错误页)。
    errorElement: <RouteErrorFallback />,
    children: [{ index: true, element: <LoginPage /> }],
  },
  {
    path: '/',
    element: <ProtectedRoute />,
    // 最外层兜底:MainLayout / 各 Gate 自身崩溃、或下层没有更近 errorElement 时
    // 冒泡到这里,全屏展示可恢复错误页(2026-07-09 React #130 事故的直接止血层)。
    errorElement: <RouteErrorFallback />,
    children: [
      {
        path: 'add-account',
        element: <AddAccountLoginPage />,
      },
      {
        // 主功能区入口 —— 经过 LocalDbGate（localDb 就绪）才能进
        element: <LocalDbGate />,
        children: [
          // 右侧栏独立子窗口(?sidebarWindow=1)的根路由 —— 与 MainLayout 平级,
          // 只挂 SidebarWindowLayout(50px chrome + RightSidebarShell),不挂完整壳。
          {
            path: 'sidebar-window',
            element: <SidebarWindowLayout />,
            errorElement: <RouteErrorFallback variant="section" />,
          },
          // 插件面板独立窗口(?ghostPanelWindow=<id>)的根路由 —— 同样与
          // MainLayout 平级,只挂 46px chrome + 面板体。
          {
            path: 'ghost-panel-window',
            element: <GhostPanelWindowLayout />,
            errorElement: <RouteErrorFallback variant="section" />,
          },
          {
            element: <MainLayout />,
            children: [
              {
                // pathless wrapper:内容区(cc-agent / skillhub / settings …)渲染
                // 崩溃时错误只占 outlet,保住 MainLayout 的导航 chrome,用户仍能
                // 切到其它页面;MainLayout 自身崩溃才冒泡到根级全屏兜底。
                errorElement: <RouteErrorFallback variant="section" />,
                children: [
                  { index: true, element: <Navigate to="/cc-agent" replace /> },
                  {
                    path: 'cc-agent',
                    element: <CCAgentFeatureLayout />,
                    children: [
                      { index: true, element: <CCAgentIndexRedirect /> },
                      // 「在新窗口打开」副窗的启动网关(静态段,必须在 :sessionId 之前匹配)。
                      // 读 ?bootSession=<id> → resolveSessionRoute → navigate(replace),
                      // 让 Orca lead/worker 副窗首屏即落到分屏路由,见 SecondaryWindowBootGate。
                      { path: 'boot', element: <SecondaryWindowBootGate /> },
                      // delayed-create: /cc-agent/new 是 transient draft 路由(无后端 session),
                      // 必须在 :sessionId 之前匹配,否则会被当作 sessionId='new' 进入 SessionView。
                      { path: 'new', element: <NewMakerDraftRoute /> },
                      // 兼容旧 deep link:新建入口已收敛到同一个可切换 workspace 的创建页。
                      { path: 'new-dialogue', element: <Navigate to="/cc-agent/new" replace /> },
                      // Scheduled — 调度任务列表（与 new 同一层级，必须在 :sessionId 之前）
                      { path: 'scheduled', element: <SchedulerPage /> },
                      // Workdir File Browser — 文件树视图(vscode-style),sidebar 自动 swap。
                      // 静态段 'files' 必须在 :sessionId 之前匹配。
                      { path: 'files/:sessionId', element: <WorkdirBrowseRoute /> },
                      { path: 'orca/new', element: <Navigate to="/cc-agent/new" replace /> },
                      { path: 'orca/:sessionId', element: <OrcaWorkflowRoute /> },
                      { path: ':sessionId', element: <CCAgentSessionView /> },
                    ],
                  },
                  {
                    // Issue Tracker — 已迁移至 GitHub，此处仅保留引导页
                    path: 'issues',
                    element: <IssueTrackerFeatureLayout />,
                  },
                  {
                    // SkillHub v0.2 —— Local skills (v0.2.1) + Market (v0.2.3)
                    path: 'skillhub',
                    element: <SkillhubFeatureLayout />,
                    children: [
                      { index: true, element: <Navigate to="/skillhub/local" replace /> },
                      {
                        path: 'local',
                        children: [
                          {
                            index: true,
                            element: <SkillhubHomeView />,
                          },
                          { path: ':kind/global/:name', element: <SkillhubDetailView /> },
                          {
                            path: ':kind/project/:projectHash/:name',
                            element: <SkillhubDetailView />,
                          },
                        ],
                      },
                      {
                        path: 'market',
                        children: [
                          { index: true, element: <SkillhubMarketListView /> },
                          // 全屏详情页/旧管理整页已移除(详情与管理统一走市场列表内的浮窗),
                          // 旧 URL 一律 fallback 回 market 列表
                          {
                            path: 'manage/:name',
                            element: <Navigate to="/skillhub/market" replace />,
                          },
                          { path: ':name', element: <Navigate to="/skillhub/market" replace /> },
                          {
                            path: ':kind/:name',
                            element: <Navigate to="/skillhub/market" replace />,
                          },
                        ],
                      },
                    ],
                  },
                  { path: 'settings', element: <SettingsView /> },
                  { path: 'plugins', element: <GhostPluginPage /> },
                  { path: 'apps/:ghostId', element: <GhostMainViewFeatureLayout /> },
                  {
                    path: 'billing',
                    element: <Navigate to="/settings?tab=billing" replace />,
                  },
                  // Maker IPC / agent event 链路诊断页(独立路由,不影响标准 chat)。
                  { path: 'maker-experimental', element: <MakerExperimentalView /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
