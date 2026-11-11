import { SettingsView } from '@/components/settings/SettingsView';
import { createHashRouter, Navigate } from 'react-router-dom';

import { MainLayout } from '@/components/layout/MainLayout';
import { MainEntryRedirect } from '@/components/layout/MainEntryRedirect';
import { RouteErrorFallback } from '@/components/error/RouteErrorFallback';
import { SidebarWindowLayout } from '@/components/layout/SidebarWindowLayout';
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
import { LegacySkillDetailRedirect } from '@/features/skillhub/LegacySkillDetailRedirect';

function EmptyRouteFallback() {
  return null;
}

/*
 * 除默认落地的任务页（新建 / 任务 / Orca）外，各功能页都用 route lazy 首次进入时才加载，
 * 主窗口首屏不再连带伙伴、Skill、插件、定时任务、文件浏览（含 CodeMirror）等页面。
 * 导航在 startTransition 里等分包就绪，期间保留当前页面；窗口直接以这些地址加载时由空的
 * HydrateFallback 占住内容区，MainLayout 导航照常显示。
 * 设计台账按 lazy 返回的 `Component: X` 识别页面组件，保持这个写法。
 */

/**
 * 三层路由架构：
 *
 *   GuestRoute (未登录)
 *    └── /login                    → LoginPage
 *
 *   ProtectedRoute (已登录) — 校验 canEnterApp（真登出或换号窗口）
 *    └── LocalDbGate               → 等 localDb.ensureReady（按 userId 切库）
 *         └── MainLayout            → 主功能区
 *              ├── /                → Restore account's last top-level entry
 *              ├── /cc-agent/...    → CCAgentFeatureLayout
 *              ├── /bots/...        → BotsFeatureLayout
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
          {
            element: <MainLayout />,
            children: [
              {
                // pathless wrapper:内容区(cc-agent / skillhub / settings …)渲染
                // 崩溃时错误只占 outlet,保住 MainLayout 的导航 chrome,用户仍能
                // 切到其它页面;MainLayout 自身崩溃才冒泡到根级全屏兜底。
                errorElement: <RouteErrorFallback variant="section" />,
                children: [
                  { index: true, element: <MainEntryRedirect /> },
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
                      {
                        path: 'scheduled',
                        lazy: () => import('@/features/scheduler').then(({ SchedulerPage }) => ({ Component: SchedulerPage })),
                        HydrateFallback: EmptyRouteFallback,
                      },
                      // Workdir File Browser — 文件树视图(vscode-style),sidebar 自动 swap。
                      // 静态段 'files' 必须在 :sessionId 之前匹配。
                      {
                        path: 'files/:sessionId',
                        lazy: () =>
                          import('@/features/cc-agent/workdir-browse/WorkdirBrowseRoute').then(({ WorkdirBrowseRoute }) => ({
                            Component: WorkdirBrowseRoute,
                          })),
                        HydrateFallback: EmptyRouteFallback,
                      },
                      { path: 'orca/new', element: <Navigate to="/cc-agent/new" replace /> },
                      { path: 'orca/:sessionId', element: <OrcaWorkflowRoute /> },
                      { path: ':sessionId', element: <CCAgentSessionView /> },
                    ],
                  },
                  {
                    path: 'bots',
                    lazy: () => import('@/features/bots/BotsFeatureLayout').then(({ BotsFeatureLayout }) => ({ Component: BotsFeatureLayout })),
                    HydrateFallback: EmptyRouteFallback,
                    children: [
                      {
                        index: true,
                        lazy: () => import('@/features/bots/BotsHomeView').then(({ BotsHomeView }) => ({ Component: BotsHomeView })),
                      },
                      {
                        path: 'list',
                        lazy: () => import('@/features/bots/BotsListView').then(({ BotsListView }) => ({ Component: BotsListView })),
                      },
                      // 阵容是主区的一页,不是浮在对话上的模态。静态段排在 :botId
                      // 之前(React Router 也按静态优先定级),所以 /bots/roster 不会
                      // 被当成一个叫 "roster" 的伙伴。
                      {
                        path: 'roster',
                        lazy: () => import('@/features/bots/BotRosterView').then(({ BotRosterView }) => ({ Component: BotRosterView })),
                      },
                      {
                        path: 'market/:packageId?',
                        lazy: () => import('@/features/bots/BotMarketDialog').then(({ BotMarketRoute }) => ({ Component: BotMarketRoute })),
                      },
                      // 伙伴群聊是独立对象(不是某位伙伴的任务),静态段 'groups' 同样排在
                      // :botId 之前,/bots/groups/<id> 不会被当成一个叫 "groups" 的伙伴。
                      {
                        path: 'groups/:groupId',
                        lazy: () => import('@/features/bots/BotGroupChatView').then(({ BotGroupChatView }) => ({ Component: BotGroupChatView })),
                      },
                      {
                        path: 'remote/:deviceId/:botId',
                        lazy: () =>
                          import('@/features/bots/RemoteBotSessionView').then(({ RemoteBotSessionView }) => ({
                            Component: RemoteBotSessionView,
                          })),
                      },
                      {
                        path: 'remote/:deviceId/:botId/session/:sessionId',
                        lazy: () =>
                          import('@/features/bots/RemoteBotSessionView').then(({ RemoteBotSessionView }) => ({
                            Component: RemoteBotSessionView,
                          })),
                      },
                      {
                        path: 'remote/:deviceId/:botId/history/:sessionId',
                        lazy: () =>
                          import('@/features/bots/BotHistorySessionView').then(({ BotHistorySessionView }) => ({
                            Component: BotHistorySessionView,
                          })),
                      },
                      // 伙伴私聊只从双方时间线里的消息入口打开，不出现在左侧伙伴列表。
                      {
                        path: ':botId/direct/:threadId',
                        lazy: () =>
                          import('@/features/bots/BotDirectMessageView').then(({ BotDirectMessageView }) => ({
                            Component: BotDirectMessageView,
                          })),
                      },
                      {
                        path: ':botId',
                        lazy: () => import('@/features/bots/BotsHomeView').then(({ BotsHomeView }) => ({ Component: BotsHomeView })),
                      },
                      {
                        path: ':botId/session/:sessionId',
                        lazy: () => import('@/features/bots/BotSessionView').then(({ BotSessionView }) => ({ Component: BotSessionView })),
                      },
                      {
                        path: ':botId/history/:sessionId',
                        lazy: () =>
                          import('@/features/bots/BotHistorySessionView').then(({ BotHistorySessionView }) => ({
                            Component: BotHistorySessionView,
                          })),
                      },
                    ],
                  },
                  {
                    // Issue Tracker — 已迁移至 GitHub，此处仅保留引导页
                    path: 'issues',
                    lazy: () =>
                      import('@/features/issue-tracker/IssueTrackerFeatureLayout').then(({ IssueTrackerFeatureLayout }) => ({
                        Component: IssueTrackerFeatureLayout,
                      })),
                    HydrateFallback: EmptyRouteFallback,
                  },
                  {
                    // SkillHub v0.2 —— Local skills (v0.2.1) + Market (v0.2.3)
                    path: 'skillhub',
                    lazy: () =>
                      import('@/features/skillhub/SkillhubFeatureLayout').then(({ SkillhubFeatureLayout }) => ({
                        Component: SkillhubFeatureLayout,
                      })),
                    HydrateFallback: EmptyRouteFallback,
                    children: [
                      { index: true, element: <Navigate to="/skillhub/local" replace /> },
                      {
                        lazy: () =>
                          import('@/features/skillhub/SkillhubLocalLayout').then(({ SkillhubLocalLayout }) => ({
                            Component: SkillhubLocalLayout,
                          })),
                        children: [
                          {
                            path: 'detail',
                            lazy: () =>
                              import('@/features/skillhub/SkillhubDetailRoute').then(({ SkillhubDetailRoute }) => ({
                                Component: SkillhubDetailRoute,
                              })),
                          },
                          {
                            path: 'local',
                            children: [
                              { index: true, element: null },
                              { path: 'by-path', element: <LegacySkillDetailRedirect /> },
                              { path: ':kind/global/:name', element: <LegacySkillDetailRedirect /> },
                              { path: ':kind/project/:projectHash/:name', element: <LegacySkillDetailRedirect /> },
                            ],
                          },
                        ],
                      },
                      {
                        path: 'market',
                        children: [
                          {
                            index: true,
                            lazy: () =>
                              import('@/features/skillhub/SkillhubMarketListView').then(({ SkillhubMarketListView }) => ({
                                Component: SkillhubMarketListView,
                              })),
                          },
                          // Existing market bookmarks resolve to the shared detail page.
                          {
                            path: 'manage/:name',
                            element: <LegacySkillDetailRedirect market />,
                          },
                          { path: ':name', element: <LegacySkillDetailRedirect market /> },
                          {
                            path: ':kind/:name',
                            element: <LegacySkillDetailRedirect market />,
                          },
                        ],
                      },
                    ],
                  },
                  { path: 'settings', element: <SettingsView /> },
                  {
                    path: 'plugins',
                    lazy: () => import('@/features/plugin/GhostPluginPage').then(({ GhostPluginPage }) => ({ Component: GhostPluginPage })),
                    HydrateFallback: EmptyRouteFallback,
                  },
                  {
                    path: 'apps/:ghostId',
                    lazy: () =>
                      import('@/features/plugin/GhostMainViewFeatureLayout').then(({ GhostMainViewFeatureLayout }) => ({
                        Component: GhostMainViewFeatureLayout,
                      })),
                    HydrateFallback: EmptyRouteFallback,
                  },
                  {
                    path: 'billing',
                    element: <Navigate to="/settings?tab=billing" replace />,
                  },
                  // Maker IPC / agent event 链路诊断页(独立路由,不影响标准 chat)。
                  {
                    path: 'maker-experimental',
                    lazy: () =>
                      import('@/features/maker-experimental/MakerExperimentalView').then(({ MakerExperimentalView }) => ({
                        Component: MakerExperimentalView,
                      })),
                    HydrateFallback: EmptyRouteFallback,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
