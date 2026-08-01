// @vitest-environment jsdom
// (Editor 构造需要 DOM。)
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collapseBlankDocDomSelection,
  EmptyDocSelectionGuard,
  isBlankParagraphDoc,
  normalizeBlankDocSelection,
  type BlankDocSelectionView,
} from '@/components/new-chat/EmptyDocSelectionGuard';
import { ComposerBulletList, ComposerListItem } from '@/components/new-chat/ComposerListNodes';
import { MentionChipNode } from '@/components/new-chat/MentionChipNode';

// Editor 必须逐个 destroy:EditorView 的异步回调会在 jsdom 环境拆除后触发
// `document is not defined` 未处理异常,vitest 全绿也会 exit 1(CI 实撞)。
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(options: { guard?: boolean } = {}): Editor {
  const { guard = true } = options;
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      ComposerListItem,
      ComposerBulletList,
      MentionChipNode,
      ...(guard ? [EmptyDocSelectionGuard] : []),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  });
  editors.push(editor);
  return editor;
}

describe('isBlankParagraphDoc', () => {
  it('只把单个空 paragraph 认作真空', () => {
    expect(isBlankParagraphDoc(makeEditor().state.doc)).toBe(true);
  });

  it('有文本时不是真空', () => {
    const editor = makeEditor();
    editor.commands.insertContent('draft');
    expect(isBlankParagraphDoc(editor.state.doc)).toBe(false);
  });

  // 多段落来自引用回填 / 历史草稿等程序化构造与多段粘贴;Shift/Alt+Enter 是
  // hardBreak(留在同一 paragraph 内),普通/修饰键 Enter 是否发送由快捷键 resolver 决定。
  it('多个空段落不是真空(多段结构本身是真实内容)', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'paragraph' }],
    });
    expect(isBlankParagraphDoc(editor.state.doc)).toBe(false);
  });

  it('只含 atom chip 的草稿不是真空(chip 没有文本投影)', () => {
    const editor = makeEditor();
    editor.commands.insertContent({
      type: 'mentionChip',
      attrs: { kind: 'file', label: 'main.ts', path: 'src/main.ts' },
    });
    expect(editor.state.doc.textContent).toBe('');
    expect(isBlankParagraphDoc(editor.state.doc)).toBe(false);
  });

  it('空列表项不是真空', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      ],
    });
    expect(isBlankParagraphDoc(editor.state.doc)).toBe(false);
  });
});

describe('normalizeBlankDocSelection', () => {
  it('真空文档的全选被折叠成光标', () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(1);
  });

  it('没有 guard 时全选会框住整个空段落(回归基线)', () => {
    // 这就是幽灵高亮的来源:AllSelection(0..2) 把空 paragraph 节点整体框进选区,
    // Chromium 于是在行首画出一块可见高亮。
    const editor = makeEditor({ guard: false });
    editor.commands.selectAll();
    expect(editor.state.selection.empty).toBe(false);
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(2);
  });

  it('有内容时全选照旧生效', () => {
    const editor = makeEditor();
    editor.commands.insertContent('hello');
    editor.commands.selectAll();
    expect(editor.state.selection.empty).toBe(false);
  });

  it('多个空段落全选照旧生效', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'paragraph' }],
    });
    editor.commands.selectAll();
    expect(editor.state.selection.empty).toBe(false);
  });

  it('全选后删空,状态层落在折叠光标上', () => {
    const editor = makeEditor();
    editor.commands.insertContent('123');
    editor.commands.selectAll();
    editor.commands.deleteSelection();
    expect(editor.state.doc.textContent).toBe('');
    expect(editor.state.selection.empty).toBe(true);
  });

  it('选区本就折叠时不产生多余 transaction', () => {
    const editor = makeEditor();
    expect(normalizeBlankDocSelection(editor.state)).toBeNull();
  });
});

describe('collapseBlankDocDomSelection', () => {
  interface FakeSelection {
    rangeCount: number;
    isCollapsed: boolean;
    anchorNode: Node | null;
    focusNode: Node | null;
    collapse: (node: Node, offset: number) => void;
  }

  function makeView(
    overrides: {
      composing?: boolean;
      docHasText?: boolean;
      selection?: Partial<FakeSelection> | null;
      anchorInside?: boolean;
      focusInside?: boolean;
    } = {},
  ): { view: BlankDocSelectionView; selection: FakeSelection } {
    const {
      composing = false,
      docHasText = false,
      anchorInside = true,
      focusInside = true,
    } = overrides;
    const editor = makeEditor();
    if (docHasText) editor.commands.insertContent('draft');
    const paragraph = { nodeName: 'P' } as unknown as Node;
    const anchor = { nodeName: '#text' } as unknown as Node;
    const focus = { nodeName: '#text' } as unknown as Node;
    const selection: FakeSelection = {
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: anchor,
      focusNode: focus,
      collapse: vi.fn(),
      ...overrides.selection,
    };
    const inside = new Set<Node>([paragraph]);
    if (anchorInside) inside.add(anchor);
    if (focusInside) inside.add(focus);
    const dom = {
      ownerDocument: { getSelection: () => (overrides.selection === null ? null : selection) },
      contains: (node: Node) => inside.has(node),
      firstChild: paragraph,
    } as unknown as HTMLElement;
    return {
      view: { composing, dom, state: { doc: editor.state.doc } },
      selection,
    };
  }

  it('真空文档 + 跨节点 DOM 选区 → 折叠到段落起点', () => {
    const { view, selection } = makeView();
    expect(collapseBlankDocDomSelection(view)).toBe(true);
    expect(selection.collapse).toHaveBeenCalledWith(view.dom.firstChild, 0);
  });

  it('DOM 选区已折叠时不动作(收敛性:第二轮直接返回)', () => {
    const { view, selection } = makeView({ selection: { isCollapsed: true } });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('文档非真空时不动作', () => {
    const { view, selection } = makeView({ docHasText: true });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('IME 组字期间不介入', () => {
    const { view, selection } = makeView({ composing: true });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('anchor 不在本 editor 内时不动作(反向拖选:从外部拖进空输入框)', () => {
    const { view, selection } = makeView({ anchorInside: false });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('focus 不在本 editor 内时不动作(从空输入框内起手往外拖选)', () => {
    // 只校验 anchor 会把这种跨边界选区当成自己的并折叠掉,清掉用户合法的选择
    // (PR #896 review:copilot + greptile P2)。
    const { view, selection } = makeView({ focusInside: false });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('两端都不在本 editor 内时不动作(同页多个 composer 互不干扰)', () => {
    const { view, selection } = makeView({ anchorInside: false, focusInside: false });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('focusNode 缺失时安全返回', () => {
    const { view, selection } = makeView({ selection: { focusNode: null } });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });

  it('没有 selection 对象时安全返回', () => {
    const { view } = makeView({ selection: null });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
  });

  it('rangeCount 为 0 时不动作', () => {
    const { view, selection } = makeView({ selection: { rangeCount: 0 } });
    expect(collapseBlankDocDomSelection(view)).toBe(false);
    expect(selection.collapse).not.toHaveBeenCalled();
  });
});
