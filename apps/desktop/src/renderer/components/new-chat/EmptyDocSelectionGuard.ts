/**
 * EmptyDocSelectionGuard —— 空输入框不留可见选区。
 *
 * Tiptap 的「空」文档不是空字符串，而是 `doc(paragraph())`，`content.size === 2`。
 * `Cmd+A` 走 baseKeymap 的 selectAll 得到 `AllSelection(0..2)`：它把那个空段落节点
 * 整体框进选区，Chromium 于是在行首画出一块约半字宽、一行高的高亮。原生 `<textarea>`
 * 空的时候全选什么都选不到，两者观感不一致。
 *
 * 实测（隔离沙箱 + DOM 探针）确认要治两层，缺一层都不够：
 *
 * - 空框按 `Cmd+A`：PM 状态层是非空的 `AllSelection`，DOM 层 `anchor=DIV:0 → focus=DIV:1`
 *   （选中 `.ProseMirror` 的整个 `<p>`）。→ 靠 `appendTransaction` 归一化成折叠光标。
 * - 输入文字后全选再删除：`AllSelection.replace()` 已把 PM 状态层折叠到 `TextSelection(1,1)`，
 *   **但 Chromium 的 DOM selection 仍跨着节点**（`collapsed=false`，rect `910x22`），高亮留在屏上。
 *   → 靠 view 层兜底折叠 DOM selection。
 *
 * 两层互相需要：只折叠 DOM 而把 `AllSelection` 留在状态层，PM 下一次 `selectionToDOM`
 * 会把它重新写回 DOM，高亮复现。
 *
 * 只认「单个空 paragraph」这一种真空形态，其余一律不介入：多个空段落、只含 atom chip 的
 * 草稿、结构化列表都带着真实内容，选中它们是合理的。
 *
 * 多段落文档在本 composer 里来自程序化构造（引用回填、历史草稿等，见
 * `lib/composerQuoteDocument.ts`）与多段粘贴，**不是**敲键敲出来的：Shift / Alt / Mod+Enter
 * 都是 hardBreak（`<br>` 留在同一个 paragraph 内），plain Enter 是发送。
 */
import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** 文档是否为「真空」——只有一个空 paragraph，没有文本也没有 atom chip。 */
export function isBlankParagraphDoc(doc: ProseMirrorNode): boolean {
  if (doc.childCount !== 1) return false;
  const only = doc.firstChild;
  return only !== null && only.type.name === 'paragraph' && only.content.size === 0;
}

/**
 * 真空文档上的非空选区（`Cmd+A` / 菜单「编辑 → 全选」得到的 `AllSelection`）归一化为
 * 段落内的折叠光标。非真空文档或选区本就折叠时返回 null（不产生多余 transaction）。
 */
export function normalizeBlankDocSelection(state: EditorState): Transaction | null {
  if (!isBlankParagraphDoc(state.doc)) return null;
  if (state.selection.empty) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, 1));
}

/** `collapseBlankDocDomSelection` 用到的最小 view 投影 —— 便于单测注入假对象。 */
export interface BlankDocSelectionView {
  readonly composing: boolean;
  readonly dom: HTMLElement;
  readonly state: { readonly doc: ProseMirrorNode };
}

/**
 * DOM 层兜底：文档已是真空、PM 状态层也已折叠，但浏览器仍持有跨节点选区时把它折叠掉。
 *
 * 只在选区**两端**都落在本 editor 内时动手。只校验 anchor 不够：从空输入框内起手往外
 * 拖选时 anchor 在 editor 内、focus 在外，折叠会清掉用户合法的跨边界选区（反向拖选时
 * anchor 已在 editor 外，本来就不会命中）。两端都查同时也让同页多个 composer 互不干扰。
 * IME 组字期间一律不介入 —— 组字的 DOM selection 归 ProseMirror 的原生 composition
 * 生命周期所有。
 *
 * 收敛性：`collapse()` 触发的 selectionchange 会被 PM 的 DOMObserver 读回并 dispatch，
 * 下一轮进来时 DOM 已折叠，直接返回 false。
 */
export function collapseBlankDocDomSelection(view: BlankDocSelectionView): boolean {
  if (view.composing) return false;
  if (!isBlankParagraphDoc(view.state.doc)) return false;
  const selection = view.dom.ownerDocument?.getSelection?.() ?? null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  if (
    !anchorNode ||
    !focusNode ||
    !view.dom.contains(anchorNode) ||
    !view.dom.contains(focusNode)
  ) {
    return false;
  }
  const paragraph = view.dom.firstChild;
  if (!paragraph) return false;
  selection.collapse(paragraph, 0);
  return true;
}

/** 供 ChatInput 与单测共享的 plugin 工厂。 */
export function createEmptyDocSelectionGuardPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (_transactions, _oldState, newState) => normalizeBlankDocSelection(newState),
    view: (view) => ({
      update: () => {
        collapseBlankDocDomSelection(view);
      },
    }),
  });
}

/** 空 composer 幽灵选区守卫。 */
export const EmptyDocSelectionGuard = Extension.create({
  name: 'emptyDocSelectionGuard',

  addProseMirrorPlugins() {
    return [createEmptyDocSelectionGuardPlugin()];
  },
});
