/**
 * Feature Sidebar Slot Context
 * ---------------------------------------------------------------------------
 * 主界面 Shell（MainLayout / Sidebar）与"主功能 Feature Layout"之间的契约。
 *
 * 架构边界（Sidebar 分层）：
 *   - 外壳层（Shell）：Sidebar（含通顶顶行）+ ContentHeader chrome + 底部
 *     用户信息区（F3）。跨所有主功能共享，永远不变。
 *   - 功能内容槽（上半）：内容由当前激活的主功能完全掌控。Shell 只提供槽位，
 *     不知道里面是什么。
 *   - ContentHeader 中部槽：右侧内容区顶栏的中部内容（会话标题等）由当前
 *     路由视图注入，Shell 只保证拖拽区 / 窗口控制按钮恒在。
 *
 * 这里实现"槽位注入"机制：
 *   - MainLayout 持有 `upperContent: ReactNode` state，通过此 Context 暴露
 *     给子树下的任意节点。
 *   - Feature Layout（如 ChatFeatureLayout）在 `useLayoutEffect` 里调用
 *     `setUpperContent(<自己的 sidebar 上半 />)`，卸载时置回 null。
 *   - Sidebar Shell 读取此 Context 的 `upperContent` 并渲染到上半区域。
 *
 * 为什么用 useLayoutEffect 而不是 useEffect：
 *   路由切换时同步阶段完成内容注入，避免旧内容先卸载 → 留一帧空白 → 新内容
 *   再挂载的视觉闪烁。
 *
 * 为什么不用 Portal：
 *   React 19 + react-router v7 下 Portal 在路由卸载/挂载时 target 引用会失效
 *   一瞬间。Context 是纯数据流，没有 DOM 副作用，更稳也更好测。
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

interface FeatureSidebarSlotContextValue {
  /** 当前 Sidebar 上半槽位的内容，由当前激活的 Feature 注入。 */
  upperContent: ReactNode;
  /** 内部 setter，Feature Layout 通过 useRegisterSidebarUpper 间接调用。 */
  setUpperContent: Dispatch<SetStateAction<ReactNode>>;
  /** 当前 ContentHeader 槽位的内容（右侧内容区顶栏中部），由当前路由视图注入。 */
  headerContent: ReactNode;
  /** 内部 setter，路由视图通过 useRegisterContentHeader 间接调用。 */
  setHeaderContent: Dispatch<SetStateAction<ReactNode>>;
  /** Sidebar 当前是否折叠，Feature 上半组件据此分支渲染。 */
  isCollapsed: boolean;
  /** 当前 Feature 是否需要 Sidebar。false 时整个 Sidebar 不显示。 */
  setSidebarEnabled: Dispatch<SetStateAction<boolean>>;
  /** 当前 Feature 是否需要 Sidebar */
  sidebarEnabled: boolean;
  /**
   * 当前 Feature 是否自行在其滚动区里渲染顶部导航的「可滚动段」(自动任务 / 插件 /
   * 按需恢复入口 / 搜索)。true 时 Shell 顶部只保留固定的「新建」行,其余交给 Feature
   * ——任务列表页据此让这些行随列表一起滚走(2026-08-12 用户裁决,对齐 Codex)。
   * 默认 false:没有长列表的视图(插件页等)仍由 Shell 整块渲染常驻行。
   */
  ownsTopNavScrollableRows: boolean;
  /** 内部 setter,Feature 经 useOwnTopNavScrollableRows 声明。 */
  setOwnsTopNavScrollableRows: Dispatch<SetStateAction<boolean>>;
}

const FeatureSidebarSlotContext = createContext<FeatureSidebarSlotContextValue | null>(null);

interface FeatureSidebarSlotProviderProps {
  isCollapsed: boolean;
  children: ReactNode;
}

/**
 * 由 MainLayout 渲染，持有 upperContent state，把 Context value 下发整个
 * Shell + Outlet 子树。
 */
export function FeatureSidebarSlotProvider({
  isCollapsed,
  children,
}: FeatureSidebarSlotProviderProps) {
  const [upperContent, setUpperContent] = useState<ReactNode>(null);
  const [headerContent, setHeaderContent] = useState<ReactNode>(null);
  const [sidebarEnabled, setSidebarEnabled] = useState(true);
  const [ownsTopNavScrollableRows, setOwnsTopNavScrollableRows] = useState(false);

  const value = useMemo<FeatureSidebarSlotContextValue>(
    () => ({
      upperContent,
      setUpperContent,
      headerContent,
      setHeaderContent,
      isCollapsed,
      sidebarEnabled,
      setSidebarEnabled,
      ownsTopNavScrollableRows,
      setOwnsTopNavScrollableRows,
    }),
    [upperContent, headerContent, isCollapsed, sidebarEnabled, ownsTopNavScrollableRows],
  );

  return (
    <FeatureSidebarSlotContext.Provider value={value}>
      {children}
    </FeatureSidebarSlotContext.Provider>
  );
}

/**
 * Sidebar Shell 读取当前要渲染的上半内容。
 * 只读，不包含 setter。
 */
export function useFeatureSidebarUpper(): ReactNode {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useFeatureSidebarUpper must be used inside <FeatureSidebarSlotProvider>');
  }
  return ctx.upperContent;
}

/**
 * Feature 上半组件内部读取当前折叠态，用于分支渲染展开/折叠两套 UI。
 */
export function useSidebarCollapsedState(): boolean {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useSidebarCollapsedState must be used inside <FeatureSidebarSlotProvider>');
  }
  return ctx.isCollapsed;
}

/**
 * MainLayout 读取当前 Feature 是否需要显示 Sidebar。
 */
export function useFeatureSidebarEnabled(): boolean {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useFeatureSidebarEnabled must be used inside <FeatureSidebarSlotProvider>');
  }
  return ctx.sidebarEnabled;
}

/**
 * Feature Layout 专用的注册 hook：
 *   - 挂载时把 `node` 设进 slot
 *   - 卸载时清空，避免下个 Feature 进入前出现旧内容残留
 *
 * 用 useLayoutEffect 确保在浏览器绘制前完成 setState，路由切换无闪烁。
 */
export function useRegisterSidebarUpper(node: ReactNode): void {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useRegisterSidebarUpper must be used inside <FeatureSidebarSlotProvider>');
  }
  const { setUpperContent } = ctx;

  useLayoutEffect(() => {
    setUpperContent(node);
    // 卸载时不清空 —— 让 sidebar 保持最后一个 Feature 注册的内容。
    // 这样导航到非 Feature 路由（如 /settings）时，sidebar 不会被清空。
    // 下一个 Feature 挂载时会自然覆盖。
  }, [node, setUpperContent]);
}

/**
 * Feature 声明「顶部导航的可滚动段由我在自己的滚动区里渲染」。
 * 与 useRegisterSidebarUpper 同款语义:卸载时**不**复位——沿用「保持最后一个
 * Feature 的声明」,避免导航到 /settings 等非 Feature 路由时顶部导航闪一下变形。
 * 下一个 Feature 挂载时自然覆盖(不接管的 Feature 传 false)。
 */
export function useOwnTopNavScrollableRows(owns: boolean): void {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useOwnTopNavScrollableRows must be used inside <FeatureSidebarSlotProvider>');
  }
  const { setOwnsTopNavScrollableRows } = ctx;

  useLayoutEffect(() => {
    setOwnsTopNavScrollableRows(owns);
  }, [owns, setOwnsTopNavScrollableRows]);
}

/** Sidebar Shell 读取:顶部导航是否只渲染固定段(可滚动段已被 Feature 接管)。 */
export function useOwnsTopNavScrollableRows(): boolean {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useOwnsTopNavScrollableRows must be used inside <FeatureSidebarSlotProvider>');
  }
  return ctx.ownsTopNavScrollableRows;
}

/**
 * ContentHeader Shell 读取当前要渲染的中部内容。
 * 只读，不包含 setter。
 */
export function useFeatureContentHeader(): ReactNode {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useFeatureContentHeader must be used inside <FeatureSidebarSlotProvider>');
  }
  return ctx.headerContent;
}

/**
 * 路由视图（如 CCAgentSessionView）注册 ContentHeader 中部内容：
 *   - 挂载时把 `node` 设进 slot
 *   - 卸载时清空 —— 与 sidebar slot 语义相反：header 标题强绑定当前视图
 *     （会话标题等），切到无 header 内容的路由时必须立刻消失，不能残留
 *     上一个会话的标题。
 *
 * 用 useLayoutEffect 确保在浏览器绘制前完成 setState，路由切换无闪烁。
 */
export function useRegisterContentHeader(node: ReactNode): void {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useRegisterContentHeader must be used inside <FeatureSidebarSlotProvider>');
  }
  const { setHeaderContent } = ctx;

  useLayoutEffect(() => {
    setHeaderContent(node);
    return () => {
      setHeaderContent(null);
    };
  }, [node, setHeaderContent]);
}

/**
 * Feature Layout 用来控制 Sidebar 是否显示。
 * - true: 显示 Sidebar
 * - false: 隐藏 Sidebar（全屏内容）
 */
export function useSetSidebarEnabled(enabled: boolean): void {
  const ctx = useContext(FeatureSidebarSlotContext);
  if (!ctx) {
    throw new Error('useSetSidebarEnabled must be used inside <FeatureSidebarSlotProvider>');
  }
  const { setSidebarEnabled } = ctx;

  useLayoutEffect(() => {
    setSidebarEnabled(enabled);
  }, [enabled, setSidebarEnabled]);
}
