/**
 * RightSidebar Tab 系统类型定义。
 *
 * Phase 1 只用到 TabKindId / TabState / TabKindMenuMeta(壳子 + 「+」dropdown)。
 * Phase 2+ 接入完整 TabKindPlugin registry + 持久化 store 时,会消费整套接口。
 *
 * Plugin 解耦原则:壳子 / TabBar / 持久层永远不感知具体 kind,只通过 registry 拿 plugin 渲染。
 */

import type { FC } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { TabCloseInterceptor } from './store';

/**
 * tab kind 联合:内置字面量 + 插件页签的动态 kind。
 * - `file-browser` / `web-browser`:Phase 3 / Phase 5 注册真实 plugin。
 * - `terminal` / `review`:占位扩展点,Phase 1 在「+」dropdown 里灰显;未来注册新 plugin 时只需在此 union 添加值 + 调 `registerTabKind`,壳子不动。
 * - `ghost:<id>`:panel.position:'tab' 的插件面板页签,由
 *   历史形态(面板收束前)由页签注册表动态注册;2026-08 起页签面板改由
 *   插件页承载,该前缀仅存在于旧会话持久化数据,Shell 发现即静默关闭
 *   (字符串与顶层布局的 ghostPanelKind 同形,DB kind 列无枚举约束可直存)。
 */
export type BuiltinTabKindId =
  | 'file-browser'
  | 'web-browser'
  | 'terminal'
  | 'review'
  | 'orca-workers'
  | 'background-tasks';
export type TabKindId = BuiltinTabKindId | `ghost:${string}`;

/** 一个 tab 运行时实例。`state` 由各 plugin 自管理结构 + 序列化,壳子只搬运。 */
export interface TabState<TKindState = unknown> {
  id: string;
  kind: TabKindId;
  state: TKindState;
}

/**
 * 「+」dropdown 里一个菜单项的元数据。Phase 1 在 `AddTabDropdown.tsx` 硬编码;
 * Phase 2 之后由 `registerTabKind(plugin)` 自动汇总。
 */
export interface TabKindMenuMeta {
  kind: TabKindId;
  /** i18n key, e.g. 'rightSidebar.tabs.kinds.fileBrowser' */
  labelKey: string;
  /**
   * 用户内容原文标签(如插件名),优先于 `t(labelKey)` 渲染 —— 插件名不是
   * i18n 资源,进不了 labelKey 体系。内置 plugin 不填。
   */
  labelText?: string;
  icon: LucideIcon;
  /** 排序值,小的在前 */
  order: number;
  /**
   * false = 进入「即将支持」分组,灰色不可点。
   * 用于在产品规划未到位时已经把扩展点摆出来给用户预期管理。
   */
  enabled: boolean;
  /** true = 不出现在「+」菜单,只能由业务入口自动创建。 */
  hiddenFromMenu?: boolean;
  /**
   * true = 每个 session 至多 1 个该 kind 的 tab。dropdown 内已存在时显示
   * "已打开" trailing 提示,点击 = setActive 现有 tab(由 host 的 onSelect
   * 走 addOrFocusSingletonTab)。当前 review 是唯一单例 kind。
   */
  singleton?: boolean;
}

/**
 * Plugin 在 TabBody 内运行时拿到的上下文(Phase 3+ 真实 plugin 用)。
 *
 * - `tabId`:本 tab 的稳定 id(同 store 内的 tab.id)。plugin 需要给跨刷新的资源
 *   做 keying 时用 —— 典型 web-browser plugin 拿它做 BrowserWebviewPool 的 entry key。
 * - `sessionId` / `workdir`:跟当前会话强绑定。Plugin 不应该假设它在不同会话间共享。
 * - `patchState`:plugin 把私有 state 改动持久化的唯一入口;由 RightSidebarShell 注入,
 *   内部统一走 store → debounce → IPC → DB(Phase 2 完整路径)。
 * - `onVisibilityChange`:壳子切顶层 tab 时通知 plugin 是否仍可见。webview plugin 用它
 *   决定要不要 mute audio / 暂停媒体等。
 */
export interface TabKindHostContext {
  tabId: string;
  sessionId: string;
  workdir: string;
  /**
   * 非空 = SSH remote 会话:workdir 是远端绝对路径,文件操作经 main 路由到
   * 远端 file-service。plugin 据此关闭本地-only 能力(watch / 系统打开 / 搜索)。
   */
  remoteHostId: string | null;
  /**
   * device-link 会话归属：字符串 = 被控设备，null = 已确认本机，undefined = 归属尚未解析。
   * 本地-only 能力必须对 undefined fail closed，避免冷启动竞态把远端路径交给本机。
   */
  deviceLinkDeviceId?: string | null;
  patchState: (patch: unknown) => void;
  onVisibilityChange: (visible: boolean) => void;
  setCloseInterceptor: (interceptor: TabCloseInterceptor | null) => () => void;
}

export interface TabPillRenderProps<TState = unknown> {
  state: TState;
  sessionId: string | null;
  active: boolean;
  t: TFunction;
}

export interface TabPillIconRenderProps<TState = unknown> {
  state: TState;
  sessionId: string | null;
  active: boolean;
}

/**
 * Plugin 完整契约(Phase 2+ 用)。
 *
 * Phase 1 暂未消费该接口,先在此固化下来是为 review 时让用户看到完整设计意图。
 * 每个 plugin 必须实现下面这套字段;新增 kind 时:在 TabKindId 加值 → 写 plugin → 调
 * `registerTabKind(plugin)`。壳子 / TabBar / 持久层全部不动。
 */
export interface TabKindPlugin<TState = unknown> {
  kind: TabKindId;
  menu: TabKindMenuMeta;
  /** Tab pill 上的标题。浏览器返回页面 title,文件浏览器返回当前文件名等。 */
  TabPillTitle: FC<TabPillRenderProps<TState>>;
  /** Tab pill 上的图标。可选;不提供时 TabBar 走 kind → 固定图标兜底。 */
  TabPillIcon?: FC<TabPillIconRenderProps<TState>>;
  /** 真正的内容区。每个 tab 实例独立挂载,display:none 切换可见性,不卸载。
   *  `active` 标记当前是否是顶层激活 tab(用户在它上面)—— plugin 据此分支处理
   *  焦点路由 / 媒体 mute / 性能节流等。可选,不读默认忽略。 */
  TabBody: FC<{
    state: TState;
    ctx: TabKindHostContext;
    active?: boolean;
    shellVisible?: boolean;
  }>;
  /** 新建 tab 时的初始状态(对应「+」点击 / EmptyState 快捷入口创建)。 */
  defaultState: () => TState;
  /** 持久化前的序列化(可选);默认 JSON.stringify,plugin 可剔除非持久字段。 */
  serializeState?: (state: TState) => unknown;
  /** 从持久化反序列化;默认 identity,plugin 可做版本兼容。 */
  hydrateState?: (raw: unknown) => TState;
  /**
   * 用户关闭 tab(store.closeTab) 时,在内部状态被清掉前 await 调一次。
   * 给 plugin 一个释放 main 进程资源的机会 —— 典型场景:terminal plugin 在这里
   * IPC dispose PTY,然后清渲染端 xterm 实例。返回 false 表示否决关闭(例如
   * 需要用户确认的协同 tab);undefined / true 均表示继续关闭。
   */
  onBeforeClose?: (
    state: TState,
    ctx: { tabId: string; sessionId: string },
  ) => Promise<boolean | void> | boolean | void;
}
