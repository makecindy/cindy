/**
 * treeScrollStore — 文件树视口的滚动锚点（内存，session 级）。
 *
 * 解决三类「视口没了又回来」的重置：
 *   1. RSB 多标签 keep-alive：切走的 tab 是 display:none，回来的帧里 scrollTop
 *      可能已被浏览器重置（且虚拟器的可见区也重新计算）；
 *   2. 「显示被忽略的目录」开关切换：开关进 store key，切换会换一份 store /
 *      换一批行，行索引整体位移 —— 直接存 scrollTop 必然错位；
 *   3. 组件卸载重挂（doc 模式离开再回来、筛选列表切回树）。
 *
 * 所以锚点不用 scrollTop，而是「顶部行的稳定 key + 行内偏移」：
 *   - 行 key 用 relPath（见 treeRows.treeRowKey），切 store / 刷新后行索引变了
 *     也能找到同一行；
 *   - 行高固定（TREE_ROW_PITCH），行内偏移给出像素级精度。
 *
 * scope = 视口身份 + store key（`makeTreeScrollScope`）。两个维度缺一不可：
 *   - store key 区分「隐藏态 / 放行态」两份树 —— 这样「隐藏被忽略目录再打开」
 *     时放行态自己的锚点还在（用户要求的恢复语义），而不是被隐藏态的位置覆盖；
 *   - 视口身份（RSB tab id / doc 侧栏）区分同一份 store 上的多个滚动容器 ——
 *     同一个 workdir 开两个文件浏览器 tab，两边各自记各自的位置。
 *
 * 只存在内存里，进程重启清零 —— 跟 fileScrollStore（文件正文滚动）同一取舍：
 * 零持久化负担，也避免长期堆积陈旧条目。
 */

import { TREE_LIST_PADDING, TREE_ROW_PITCH, treeRowKey, type TreeRow } from './treeRows';

export interface TreeScrollAnchor {
  /** 顶部行的 treeRowKey。 */
  rowKey: string;
  /** 该行顶部到视口顶部的像素偏移（0 ≤ offset < TREE_ROW_PITCH）。 */
  offset: number;
}

/** 视口 + store 的组合键。分隔符用 NUL：POSIX/Windows 路径都不可能出现。 */
export function makeTreeScrollScope(viewport: string, storeKey: string): string {
  return `${viewport}\u0000${storeKey}`;
}

/** Map 上限：LRU 淘汰。每条 entry 不到 100 字节，上限只是防止长期不关的会话无限堆积。 */
const MAX_SCOPES = 128;

const anchors = new Map<string, TreeScrollAnchor>();

export function saveTreeScrollAnchor(scope: string, anchor: TreeScrollAnchor): void {
  // 先删再塞 = 移到 Map 尾部；淘汰时从头部删，即最久未写入的 scope。
  anchors.delete(scope);
  anchors.set(scope, anchor);
  while (anchors.size > MAX_SCOPES) {
    const oldest = anchors.keys().next().value;
    if (oldest === undefined) break;
    anchors.delete(oldest);
  }
}

export function loadTreeScrollAnchor(scope: string): TreeScrollAnchor | null {
  return anchors.get(scope) ?? null;
}

/** 测试专用：清空模块级状态。 */
export function _resetTreeScrollAnchorsForTests(): void {
  anchors.clear();
}

/**
 * 当前 scrollTop 对应的锚点。rows 为空返回 null。
 * 注意：调用方要先确认容器可见 —— display:none 时 scrollTop 会复位，不能当真实位置。
 */
export function computeTreeScrollAnchor(
  rows: readonly TreeRow[],
  scrollTop: number,
): TreeScrollAnchor | null {
  if (rows.length === 0) return null;
  const offsetInList = Math.max(0, scrollTop - TREE_LIST_PADDING);
  const index = Math.min(rows.length - 1, Math.floor(offsetInList / TREE_ROW_PITCH));
  const row = rows[index];
  if (!row) return null;
  return {
    rowKey: treeRowKey(row),
    // scrollTop 理论上不会超真实 maxScroll（浏览器会鉗），但 jsdom / 程序性赋值
    // 下可能越界；这里守住「0 ≤ offset < pitch」的不变量，避免锚点记录失真。
    offset: Math.min(offsetInList - index * TREE_ROW_PITCH, TREE_ROW_PITCH - 1),
  };
}

/**
 * 锚点行在当前 rows 里的 scrollTop。行不在树里（被折叠 / 数据未到 / 已删除）
 * 返回 null —— 调用方自己决定是放弃还是等下一次 rows 变化再试。
 */
export function computeTreeRestoreScrollTop(
  rows: readonly TreeRow[],
  anchor: TreeScrollAnchor,
): number | null {
  const index = rows.findIndex((row) => treeRowKey(row) === anchor.rowKey);
  if (index < 0) return null;
  return TREE_LIST_PADDING + index * TREE_ROW_PITCH + anchor.offset;
}
