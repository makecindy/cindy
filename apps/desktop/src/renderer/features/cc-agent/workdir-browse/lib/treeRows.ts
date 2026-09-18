/**
 * treeRows — FileTreeView 的扁平行模型（纯数据，无 React 依赖）。
 *
 * 树的真身是 `entries: Map<relPath, DirEntry[]>`（按目录懒加载）+ `expanded: Set`。
 * 渲染 / 虚拟化 / 滚动锚点都需要同一份「按显示顺序展开成一行一行」的结果，这里
 * 是唯一来源：
 *   - flattenTree：Map × Set → 扁平行数组；
 *   - treeRowKey：行的稳定 key（虚拟器的 getItemKey 与滚动锚点共用）。
 *
 * 行几何（pitch / padding）也在这里：虚拟器估算行高、滚动锚点把 scrollTop 换算
 * 成行索引，两边必须用同一组常量，写两份迟早会漂移。
 */

import type { DirEntry } from '../hooks/useFileTree';

/**
 * 行 pitch = 行本身 h-7（28px）+ 行间 1px（原实现靠容器 gap-px，虚拟化后由
 * 绝对定位的 pitch 承担）。CDP 实测：行高 28、相邻行 top 差 29。
 */
export const TREE_ROW_PITCH = 29;

/** 列表首尾各留 8px（原容器的 py-2）。交给虚拟器的 paddingStart/paddingEnd ——
 *  行是绝对定位相对内容盒算的，容器自己带 padding 会让行位置整体偏移。 */
export const TREE_LIST_PADDING = 8;

export interface PendingCreate {
  kind: 'file' | 'folder';
  /** workdir-relative POSIX path of the parent folder; '' = root. */
  parentRel: string;
}

interface TreeEntryRow {
  kind: 'entry';
  entry: DirEntry;
  depth: number;
}

interface TreePendingRow {
  kind: 'pending';
  pending: PendingCreate;
  depth: number;
}

export type TreeRow = TreeEntryRow | TreePendingRow;

/**
 * 行数据：把 entries × expanded 展开成扁平行数组。
 *
 * pendingCreate 注入位置：在父行发出后立刻插一个 pending 行（深度 = 父行+1）；
 * 父是 root('') 时插在最顶。这样视觉上 pending 行紧贴父目录，即使父目录里还没有
 * 任何 children 也能看到输入框，符合 VSCode 体验。
 */
export function flattenTree(
  entries: ReadonlyMap<string, readonly DirEntry[]>,
  expanded: ReadonlySet<string>,
  pending: PendingCreate | null | undefined,
): TreeRow[] {
  const out: TreeRow[] = [];
  const root = entries.get('') ?? [];

  if (pending && pending.parentRel === '') {
    out.push({ kind: 'pending', pending, depth: 0 });
  }

  const visit = (list: readonly DirEntry[], depth: number) => {
    for (const entry of list) {
      out.push({ kind: 'entry', entry, depth });
      if (entry.type === 'directory') {
        // 嵌套 pending 行：父行 push 完之后立刻插 —— 不依赖 children 是否已加载，
        // 没加载时输入框单独悬挂在父下方，跟 VSCode 行为一致。
        if (pending && pending.parentRel === entry.relPath) {
          out.push({ kind: 'pending', pending, depth: depth + 1 });
        }
        if (expanded.has(entry.relPath)) {
          const children = entries.get(entry.relPath);
          if (children) visit(children, depth + 1);
        }
      }
    }
  };
  visit(root, 0);
  return out;
}

/**
 * 行的稳定 key：虚拟器的 getItemKey 与「滚动锚点」共用同一套标识。
 * entry 行用 relPath；临时输入行用 parent+kind 组合（同一父目录同时只可能有一行）。
 */
export function treeRowKey(row: TreeRow): string {
  if (row.kind === 'pending') {
    return `__pending__:${row.pending.parentRel}:${row.pending.kind}`;
  }
  return row.entry.relPath;
}
