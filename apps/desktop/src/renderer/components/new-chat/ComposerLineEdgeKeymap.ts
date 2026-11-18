/**
 * macOS Ctrl+A / Ctrl+E —— 移到光标所在行的行首 / 行尾。
 *
 * Tiptap 核心键位在 macOS 上把这两个键绑定为 selectTextblockStart/End,即整个
 * 段落的开头和结尾。Composer 里 Shift+Enter 插入的是段内换行(hardBreak),手打
 * 的多行内容往往同属一段,于是 Ctrl+A / E 会跳到整块内容的头尾。这里改按
 * hardBreak 划分的"行"移动,与 macOS 原生输入框一致(按逻辑行,不按自动折行)。
 * 其他平台上 Ctrl+A 是全选,不注册。
 */
import { Extension } from '@tiptap/core';
import { TextSelection, type EditorState } from '@tiptap/pm/state';

export type CaretLineEdge = 'start' | 'end';

/** 光标(选区 head)所在行在 doc 中的行首或行尾位置;不在文本块内时返回 null。 */
export function caretLineEdgePosition(state: EditorState, edge: CaretLineEdge): number | null {
  const { $head } = state.selection;
  if (!$head.parent.isTextblock) return null;
  const contentStart = $head.start();
  let lineStart = contentStart;
  let lineEnd = $head.end();
  let foundLineEnd = false;
  $head.parent.forEach((child, offset) => {
    if (child.type.name !== 'hardBreak') return;
    const breakPos = contentStart + offset;
    if (breakPos < $head.pos) {
      lineStart = breakPos + child.nodeSize;
    } else if (!foundLineEnd) {
      lineEnd = breakPos;
      foundLineEnd = true;
    }
  });
  return edge === 'start' ? lineStart : lineEnd;
}

export interface ComposerLineEdgeKeymapOptions {
  enabled: boolean;
}

export const ComposerLineEdgeKeymap = Extension.create<ComposerLineEdgeKeymapOptions>({
  name: 'composerLineEdgeKeymap',
  // 高于 Tiptap 核心 Keymap(默认 100),先于它的 selectTextblockStart/End 处理。
  priority: 1000,

  addOptions() {
    return { enabled: false };
  },

  addKeyboardShortcuts(): Record<string, () => boolean> {
    if (!this.options.enabled) return {};
    const moveTo = (edge: CaretLineEdge) => () => {
      const { state, view } = this.editor;
      const position = caretLineEdgePosition(state, edge);
      if (position === null) return false;
      view.dispatch(
        state.tr.setSelection(TextSelection.create(state.doc, position)).scrollIntoView(),
      );
      return true;
    };
    return {
      'Ctrl-a': moveTo('start'),
      'Ctrl-e': moveTo('end'),
    };
  },
});
