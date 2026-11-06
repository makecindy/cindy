/**
 * Pending queue row activity state.
 *
 * 行内操作按钮只应该在“正在指向这一行”或“键盘焦点仍在这一行内”时出现。
 * 之前把 hover 写成单一 selectedClientId,只有 enter 没有 leave,鼠标移走后
 * 最后一行会永久带着插话/编辑/删除按钮,看起来像队列内容的一部分。这里把
 * hover 与 focus 拆开,让鼠标离开能清掉 hover,同时保留键盘可访问性。
 */

export interface PendingQueueRowActivityState {
  hoveredClientId: string | null;
  focusedClientId: string | null;
}

export const emptyPendingQueueRowActivityState: PendingQueueRowActivityState = {
  hoveredClientId: null,
  focusedClientId: null,
};

export function activatePendingQueueRowHover(
  state: PendingQueueRowActivityState,
  clientId: string,
  editingClientId: string | null,
): PendingQueueRowActivityState {
  if (editingClientId !== null || state.hoveredClientId === clientId) return state;
  return { ...state, hoveredClientId: clientId };
}

export function deactivatePendingQueueRowHover(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.hoveredClientId !== clientId) return state;
  return { ...state, hoveredClientId: null };
}

export function activatePendingQueueRowFocus(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.focusedClientId === clientId) return state;
  return { ...state, focusedClientId: clientId };
}

export function deactivatePendingQueueRowFocus(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.focusedClientId !== clientId) return state;
  return { ...state, focusedClientId: null };
}

export function isPendingQueueRowActive(
  state: PendingQueueRowActivityState,
  clientId: string,
): boolean {
  return state.hoveredClientId === clientId || state.focusedClientId === clientId;
}

/**
 * 正文全文提示(截断行悬停)的目标行。
 *
 * 历史 bug:这条判定曾经是面板级单一布尔,只在行 hover 时按当行量一次、离开不清零,
 * 于是「本行是否被截断」会残留到下一次激活 —— 键盘把焦点移到一条没被截断的短行也照弹
 * 全文,指针悬停 A 行、焦点落在 B 行时还会两行同真。目标行因此必须绑定到具体 clientId,
 * 任何时刻最多只有一个行能开。受控浮层也会绕过 Tip 的 hover delay,所以这里还额外
 * 记一个「已等满延迟的行」:指针划过列表时不立刻铺开全文。
 */
export type PendingQueueBodyTipTarget = string | null;

export interface PendingQueueBodyTipRow {
  clientId: string;
  /** 合成指令行按契约只显示标签,不给原文。 */
  syntheticTrigger: boolean;
  /** 编辑态正文在主输入框里改,行内不再挂浮层。 */
  editing: boolean;
  /** 拖动排序全程不收浮层,否则全文提示会跟着指针压住整列。 */
  dragActive: boolean;
}

/**
 * 正文全文提示只在「就是这一行、且延迟已满、没有别的交互正在占用这块屏幕」时打开。
 * target 是实测到溢出的行,revealed 是等满悬停延迟后的行 —— 两者都得是本行。
 */
export function isPendingQueueBodyTipOpen(
  target: PendingQueueBodyTipTarget,
  revealed: PendingQueueBodyTipTarget,
  row: PendingQueueBodyTipRow,
): boolean {
  if (target === null || target !== revealed || target !== row.clientId) return false;
  return !row.syntheticTrigger && !row.editing && !row.dragActive;
}

export function prunePendingQueueRowActivity(
  state: PendingQueueRowActivityState,
  validClientIds: readonly string[],
): PendingQueueRowActivityState {
  const hasHovered =
    state.hoveredClientId === null || validClientIds.includes(state.hoveredClientId);
  const hasFocused =
    state.focusedClientId === null || validClientIds.includes(state.focusedClientId);
  if (hasHovered && hasFocused) return state;
  return {
    hoveredClientId: hasHovered ? state.hoveredClientId : null,
    focusedClientId: hasFocused ? state.focusedClientId : null,
  };
}
