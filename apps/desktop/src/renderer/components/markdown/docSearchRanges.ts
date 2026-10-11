/**
 * docSearchRanges — 文档内搜索命中的共享 state 契约。
 *
 * 为什么需要一个挂在 state 上的共享契约:markdown live preview 把表格 /
 * mermaid / 图片整块换成 `Decoration.replace({block: true, widget})`。widget
 * 覆盖区间内的文档文本不再由 CodeMirror 的行视图渲染,落在同一区间上的
 * `Decoration.mark`(`cm-doc-search-match`)无处可显示 —— 搜索条会报
 * "1/2",但表格里的那一处永远没有高亮。命中位置因此必须能被 widget 自己
 * 读到,由 widget 在自己的 DOM 里补画高亮(见 markdownTableLivePreview)。
 *
 * 可见性口径由 PlaintextEditor.collectDocSearchHiddenRanges 集中提供(表格
 * 结构字符、图片、mermaid、conceal 标记),本文件只提供命中集合的存取与纯
 * 过滤,不反向依赖任何渲染模块,避免循环。
 *
 * 口径的底线:命中的东西用户一定看得见。报一个看不见也点不到的命中,比
 * 少报一个不可见字符更糟。
 */
import { StateEffect, StateField } from '@codemirror/state';

export interface DocSearchRange {
  from: number;
  to: number;
  active: boolean;
}

/** 一次搜索运行的完整命中集合(含 active 标记)。派发空数组 = 清除高亮。 */
export const setDocSearchRangesEffect = StateEffect.define<DocSearchRange[]>();

/**
 * 命中集合的单一真相源。
 *
 * 挂在 state 上而不是组件 ref 上,是为了让 live preview 的 decoration field
 * 能在同一次事务里读到它(doc 变化时映射位置、搜索变化时重画 widget 高亮)。
 * 纯 code / 纯文本文件可以只注册 mark decoration 而不注册本 field,读取方
 * 一律用 `field(…, false)` 容忍缺席。
 */
export const docSearchRangesField = StateField.define<DocSearchRange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDocSearchRangesEffect)) return e.value;
    }
    if (!tr.docChanged || value.length === 0) return value;
    // 编辑模式下用户敲字会挪动命中位置:跟随 changes 映射,避免高亮落在
    // 错位的字符上(两端分别向外/向内贴边,保持区间语义)。
    return value.map((range) => ({
      ...range,
      from: tr.changes.mapPos(range.from, 1),
      to: tr.changes.mapPos(range.to, -1),
    }));
  },
});

export interface DocSearchHiddenRange {
  from: number;
  to: number;
}

/**
 * 丢掉任何与不可见区间相交的命中,使"命中计数"与"可见高亮"始终一致。
 *
 * `ranges` 按位置递增(SearchCursor 从 0 扫到 doc.length),所以先把 hidden
 * 排序合并再用双指针扫一遍即可 —— 早先的 `hidden.some(...)` 是 O(n×m),长文档
 * 里隐藏标记多 + 命中多时每次输入都要重扫,会让搜索框发涩。
 */
export function filterVisibleDocSearchRanges(
  ranges: DocSearchRange[],
  hidden: DocSearchHiddenRange[],
): DocSearchRange[] {
  if (hidden.length === 0 || ranges.length === 0) return ranges;
  const merged = mergeHiddenRanges(hidden);
  const out: DocSearchRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < merged.length && merged[cursor].to <= range.from) cursor++;
    const next = merged[cursor];
    // 与下一个隐藏区间相交 → 不可见;不相交时保留并不推进游标(后面的命中可能才相交)。
    if (next && next.from < range.to) continue;
    out.push(range);
  }
  return out;
}

function mergeHiddenRanges(ranges: DocSearchHiddenRange[]): DocSearchHiddenRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: DocSearchHiddenRange[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

/** 取出落在 [from, to) 内的命中(表格 widget 用它在自己 DOM 里补画高亮)。 */
export function selectDocSearchRangesWithin(
  ranges: DocSearchRange[],
  from: number,
  to: number,
): DocSearchRange[] {
  return ranges.filter((range) => range.from < to && range.to > from);
}
