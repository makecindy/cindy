/**
 * railPanelStore — 折叠 rail 二级面板的跨组件状态桥。
 * ---------------------------------------------------------------------------
 * 为什么要一个 store:rail 瓷砖(CollapsedView/RailNav,折叠态可见)与面板内容
 * (RailPanels,由 **ExpandedView** 渲染)不在同一子树 —— 面板行要复用展开态的
 * 全套会话操作(archive 两步确认 / 右键菜单 / 重命名 / 移动 / schedule 操作),
 * 这些 handler 全部长在 ExpandedView 内部且深度耦合其状态;两视图常驻挂载
 * (opacity 互换),portal 面板不受隐藏 wrapper 影响,因此让 ExpandedView 渲染
 * 面板即可**零复制**继承全部行为,永不与展开态漂移。
 *
 * 本 store 只承载「开哪个面板 + 锚点 + 120ms hover 桥接计时」这一点点状态,
 * useSyncExternalStore 消费;快照对象引用稳定,只在变更时整体替换。
 */

export type RailPanelSection = 'projects' | 'dialogues';

export interface RailPanelAnchor {
  right: number;
  top: number;
}

export interface RailPanelState {
  openSection: RailPanelSection | null;
  anchor: RailPanelAnchor | null;
  /** 触发瓷砖元素——RailPanels 用 IntersectionObserver 监测其可见性,
   *  触发器消失(⌘B 完全隐藏 / rail 滚出)即收面板,不依赖指针再动。 */
  anchorEl: HTMLElement | null;
  /** 本次面板由键盘激活打开(Enter/Space):按 popover 焦点契约,焦点移入面板、
   *  hover 宽限收回让位,只经 Esc/面板外点击/执行动作显式关闭。 */
  openedViaKeyboard: boolean;
  openProjectKey: string | null;
  /** 项目三级面板由键盘打开(Enter/Space 于项目行):同 popover 契约。 */
  projectOpenedViaKeyboard: boolean;
  projectAnchor: RailPanelAnchor | null;
  /** 灯语取样范围(会话 id):由 RailPanels(ExpandedView)发布,与面板实际
   *  展示的过滤后集合一致(vendor/项目筛选/未分类都算);null = 尚未发布,
   *  RailNav 回落到自身按机器过滤的推导。 */
  lampScope: RailLampScope | null;
}

export interface RailLampScope {
  projectSessionIds: readonly string[];
  dialogueSessionIds: readonly string[];
}

/** hover 桥接:指针离开瓷砖/面板后的收回宽限(与 peek 抽屉同量级)。 */
export const RAIL_PANEL_CLOSE_GRACE_MS = 120;

const CLOSED_FIELDS = {
  openSection: null,
  anchor: null,
  anchorEl: null,
  openedViaKeyboard: false,
  openProjectKey: null,
  projectOpenedViaKeyboard: false,
  projectAnchor: null,
} as const;

const INITIAL: RailPanelState = { ...CLOSED_FIELDS, lampScope: null };

let state: RailPanelState = INITIAL;
const listeners = new Set<() => void>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let projectCloseTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: RailPanelState): void {
  state = next;
  for (const listener of listeners) listener();
}

function clearCloseTimer(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}
function clearProjectCloseTimer(): void {
  if (projectCloseTimer) { clearTimeout(projectCloseTimer); projectCloseTimer = null; }
}

/** 面板内有**行内编辑焦点**(双击重命名的 input 等)时抑制 hover 宽限收回:
 *  面板不是纯 hover 浮层,编辑期间指针短暂离开不能拆掉编辑器丢用户输入。
 *  只认可编辑元素,不认普通按钮焦点——否则点过行的面板永远不自动收。
 *  显式收回(Esc / 面板外点击 / closeAll)不受此限。 */
export function panelHasEditingFocus(): boolean {
  const ae = typeof document !== 'undefined' ? document.activeElement : null;
  if (!(ae instanceof HTMLElement) || !ae.closest('[data-rail-panel]')) return false;
  return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable;
}

/** 有模态浮层打开时抑制 hover 宽限收回。判定直接读模态浮层的标志性副作用——
 *  body 上的 pointer-events:none(Radix DismissableLayer 在 modal 时挂上):
 *  这正是面板指针保活失灵的唯一根源——mouseleave 的 relatedTarget 不再匹配
 *  保活白名单、全局 pointermove 的 target 退化成 `<html>`,都会误判「指针已
 *  离开」把面板连同刚弹出的菜单一起收掉(实测:行 ⋮ 菜单弹出即自动关闭;
 *  右键菜单因光标恰好落在菜单内容上而幸免)。该状态存在时任何「指针已离开」
 *  信号都不可信,抑制收回是唯一安全解;状态解除后下一次 pointermove 立即恢复
 *  正常收回语义。对比全局扫描浮层 DOM 的方案(review 三连):
 *  - 非模态 dialog(如全局 FindInPageBar 的常驻 role="dialog")不改 body,
 *    指针语义完好,不会被误判抑制;
 *  - 与面板无关的模态浮层打开期间,指针信号本身已不可信,抑制悬留、浮层
 *    关闭后由下一次 pointermove 收回,是可达的最优行为;
 *  - 纯 inline style 读取,热路径(全局 pointermove)零选择器解析开销,
 *    也没有 :has 的引擎兼容面。 */
export function panelHasBlockingOverlay(): boolean {
  // body 可空(极早初始化 / 非浏览器测试环境),空时按无浮层处理。
  const body = typeof document !== 'undefined' ? document.body : null;
  return body != null && body.style.pointerEvents === 'none';
}

function suppressAutoClose(): boolean {
  return panelHasEditingFocus() || panelHasBlockingOverlay();
}

export const railPanelStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): RailPanelState {
    return state;
  },

  /** 打开(或切换)一级面板;同时收起可能开着的项目二级。 */
  openSection(
    section: RailPanelSection,
    anchor: RailPanelAnchor,
    anchorEl: HTMLElement,
    viaKeyboard = false,
  ): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    emit({
      ...state,
      openSection: section,
      anchor,
      anchorEl,
      openedViaKeyboard: viaKeyboard,
      openProjectKey: null,
      projectAnchor: null,
      projectOpenedViaKeyboard: false,
    });
  },

  /** 由 RailPanels 发布与面板展示一致的灯语取样范围(浅比较去抖,防循环)。 */
  setLampScope(scope: RailLampScope | null): void {
    const prev = state.lampScope;
    const same =
      (prev == null && scope == null) ||
      (prev != null &&
        scope != null &&
        prev.projectSessionIds.length === scope.projectSessionIds.length &&
        prev.dialogueSessionIds.length === scope.dialogueSessionIds.length &&
        prev.projectSessionIds.every((id, i) => id === scope.projectSessionIds[i]) &&
        prev.dialogueSessionIds.every((id, i) => id === scope.dialogueSessionIds[i]));
    if (same) return;
    emit({ ...state, lampScope: scope });
  },
  /** 项目一级面板内 hover 具体项目 → 打开二级。 */
  openProject(projectKey: string, anchor: RailPanelAnchor, viaKeyboard = false): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state.openSection !== 'projects') return;
    emit({
      ...state,
      openProjectKey: projectKey,
      projectAnchor: anchor,
      projectOpenedViaKeyboard: viaKeyboard,
    });
  },

  cancelClose(): void {
    clearCloseTimer();
  },
  scheduleClose(): void {
    // 键盘打开的面板不做 hover 宽限收回(popover 契约:显式关闭)。
    if (state.openedViaKeyboard) return;
    if (suppressAutoClose()) return;
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      // 触发时再验一次:浮层可能在计时器排下之后、走完之前才挂载
      // (点击 ⋮ → mouseleave 先到、菜单内容后 mount 的竞态)。
      if (suppressAutoClose()) return;
      railPanelStore.closeAll();
    }, RAIL_PANEL_CLOSE_GRACE_MS);
  },
  cancelProjectClose(): void {
    clearProjectCloseTimer();
  },
  scheduleProjectClose(): void {
    if (state.openedViaKeyboard || state.projectOpenedViaKeyboard) return;
    if (suppressAutoClose()) return;
    clearProjectCloseTimer();
    projectCloseTimer = setTimeout(() => {
      projectCloseTimer = null;
      if (suppressAutoClose()) return;
      if (state.openProjectKey)
        emit({ ...state, openProjectKey: null, projectAnchor: null, projectOpenedViaKeyboard: false });
    }, RAIL_PANEL_CLOSE_GRACE_MS);
  },

  closeAll(): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state.openSection !== null || state.anchorEl !== null) {
      emit({ ...state, ...CLOSED_FIELDS });
    }
  },
};
