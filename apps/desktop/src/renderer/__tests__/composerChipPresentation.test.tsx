// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import History from '@tiptap/extension-history';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ComposerQuoteNode } from '@/components/new-chat/ComposerQuoteNode';
import { MentionChipNode } from '@/components/new-chat/MentionChipNode';
import { PastedTextChipNode } from '@/components/new-chat/PastedTextChipNode';

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

// jsdom 不实现 Range 上的几何方法，而 ProseMirror 在 focus/scrollIntoView 的
// coordsAtPos 路径上会按内部时序（requestAnimationFrame 刷新）调用它们——CI 上
// 曾因此出现 `target.getClientRects/getBoundingClientRect is not a function`
// 的闪红。给单零矩形的最小实现，让滚动定位走兜底路径，行为与真实浏览器的
// 空视口一致。
if (typeof Range !== 'undefined') {
  const zeroRect = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 };
  const rangeProto = Range.prototype as unknown as Record<string, unknown>;
  if (!rangeProto.getClientRects) {
    rangeProto.getClientRects = () => ({ 0: zeroRect, length: 1, item: () => zeroRect });
  }
  if (!rangeProto.getBoundingClientRect) {
    rangeProto.getBoundingClientRect = () => zeroRect;
  }
}

afterEach(() => {
  cleanup();
});

class TestDataTransfer {
  private readonly values = new Map<string, string>();

  files: File[] = [];
  effectAllowed = 'uninitialized';
  dropEffect = 'none';

  get types(): string[] {
    return [...this.values.keys()];
  }

  clearData(type?: string): void {
    if (type) this.values.delete(type);
    else this.values.clear();
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  setDragImage(): void {}
}

function ComposerHarness({ onEditor }: { onEditor?: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, MentionChipNode, PastedTextChipNode, ComposerQuoteNode],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mentionChip',
              attrs: { kind: 'file', label: 'main.ts', path: 'src/main.ts' },
            },
            {
              type: 'mentionChip',
              attrs: {
                kind: 'plugin-capability',
                label: 'ios-simulator',
                path: 'ios-simulator',
                pluginId: 'ios-simulator',
                sourceLabel: 'iOS Simulator',
              },
            },
            { type: 'text', text: ' /skill between ' },
            {
              type: 'pastedTextChip',
              attrs: { text: 'first\nsecond', display: 'Pasted text (2 lines)' },
            },
            {
              type: 'composerQuote',
              attrs: { text: 'quoted', sourcePath: null, startLine: null, endLine: null },
            },
          ],
        },
      ],
    },
    onCreate: ({ editor: createdEditor }) => onEditor?.(createdEditor),
  });

  return <EditorContent editor={editor} />;
}

describe('composer atomic chip presentation', () => {
  it('aligns selected-text quotes and every other atom to the same text baseline', () => {
    // 规则体用 [^}] 界定，不假设 `}` 前面正好是换行：CSS 声明里不会出现 `}`，
    // 所以缩进或换行风格调整不会再让这条断言失配（同下面那条间距用例）。
    const alignmentRule = globalsSource.match(
      /\.ProseMirror :is\(\[data-mention-chip\], \[data-pasted-text-chip\], \[data-composer-quote\]\)\s*\{([^}]*)\}/,
    )?.[1];

    expect(alignmentRule).toContain('position: relative');
    expect(alignmentRule).toContain('top: -1px');
  });

  it('keeps the caret and prose 4px away from every composer pill', () => {
    // 按「规则体设了 margin-inline」定位这条共用外间距规则，而不是把整份选择器
    // 列表写死：这条 :is() 是所有 composer 胶囊共用的，新增胶囊时会往列表里加成员
    // （如 #599 的 .quick-start-pill）。写死完整列表会让那类改动把断言变成
    // gapRule === undefined，报出与本意无关的 "undefined and string" 断言错误。
    const gapRuleMatch = [
      ...globalsSource.matchAll(/\.ProseMirror :is\(([^)]*)\)\s*\{([^}]*)\}/g),
    ].find(([, , body]) => body.includes('margin-inline'));
    const [, gapSelectors, gapRule] = gapRuleMatch ?? [];

    // 已知胶囊必须都在共用列表里（防的是「某个胶囊被漏掉」，而不是列表长度）。
    // 新增胶囊时把它加进这份清单，用例才真的覆盖「每一个 composer 胶囊」。
    expect(gapSelectors).toBeDefined();
    for (const pill of [
      '[data-mention-chip]',
      '[data-pasted-text-chip]',
      '[data-composer-quote]',
      '.ghost-cmd-pill',
      '.slash-cmd-pill',
      '.quick-start-pill',
    ]) {
      expect(gapSelectors).toContain(pill);
    }
    expect(gapRule).toContain('margin-inline: 4px');
  });

  it('gives every atom the shared pill and a non-selecting native drag handle', async () => {
    const { container } = render(<ComposerHarness />);
    const atoms = await waitFor(() => {
      const renderedAtoms = [
        ...container.querySelectorAll<HTMLElement>('[data-mention-chip]'),
        container.querySelector<HTMLElement>('[data-pasted-text-chip]'),
        container.querySelector<HTMLElement>('[data-composer-quote]'),
      ];
      expect(renderedAtoms.every(Boolean)).toBe(true);
      return renderedAtoms;
    });

    for (const atom of atoms) {
      expect(atom?.hasAttribute('data-drag-handle')).toBe(true);
      expect(atom?.draggable).toBe(true);
      expect(atom?.style.userSelect).toBe('none');
      expect(atom?.querySelector('[data-inline-reference-chip]')?.className).toContain(
        'rounded-full',
      );
      expect(atom?.querySelector('[data-inline-reference-chip]')?.className).toContain(
        'text-[var(--text-primary)]',
      );
      if (atom?.hasAttribute('data-composer-quote')) {
        // 引用胶囊是唯一带删除控件的 atom：真实 <button>，带本地化 aria-label。
        const removeButton = atom.querySelector('button');
        expect(removeButton?.getAttribute('type')).toBe('button');
        expect(removeButton?.getAttribute('aria-label') ?? '').toBeTruthy();
      } else {
        expect(atom?.querySelector('button')).toBeNull();
      }
    }
    expect(container.querySelector('[data-mention-chip][data-kind="slash"]')).toBeNull();
    expect(
      container.querySelector(
        '[data-mention-chip][data-kind="plugin-capability"] svg.lucide-puzzle',
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain('ios-simulator');
    expect(container.textContent).toContain('/skill');
  });

  it('keeps atoms removable through node selection without close buttons', async () => {
    let activeEditor: Editor | null = null;
    const { container } = render(
      <ComposerHarness
        onEditor={(editor) => {
          activeEditor = editor;
        }}
      />,
    );
    const editor = await waitFor(() => {
      if (!activeEditor) throw new Error('Composer editor was not created');
      return activeEditor;
    });

    let mentionPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'mentionChip' || node.attrs.kind !== 'file') return true;
      mentionPos = pos;
      return false;
    });
    if (mentionPos === null) throw new Error('Mention atom was not found');
    editor.chain().setNodeSelection(mentionPos).deleteSelection().run();

    await waitFor(() =>
      expect(container.querySelector('[data-mention-chip][data-kind="file"]')).toBeNull(),
    );
    expect(container.querySelector('[data-mention-chip][data-kind="slash"]')).toBeNull();
    expect(container.querySelector('[data-pasted-text-chip]')).not.toBeNull();
    expect(container.querySelector('[data-composer-quote]')).not.toBeNull();
  });

  it('moves an atom through ProseMirror drag and drop instead of selecting its text', async () => {
    let activeEditor: Editor | null = null;
    const { container } = render(
      <ComposerHarness
        onEditor={(editor) => {
          activeEditor = editor;
        }}
      />,
    );
    const editor = await waitFor(() => {
      if (!activeEditor) throw new Error('Composer editor was not created');
      return activeEditor;
    });
    const mention = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-mention-chip][data-kind="file"]');
      if (!element) throw new Error('Mention atom was not rendered');
      return element;
    });

    let mentionPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'mentionChip' || node.attrs.kind !== 'file') return true;
      mentionPos = pos;
      return false;
    });
    if (mentionPos === null) throw new Error('Mention atom was not found');

    const originalPosAtCoords = editor.view.posAtCoords;
    editor.view.posAtCoords = () => ({ pos: mentionPos!, inside: mentionPos! });
    const dataTransfer = new TestDataTransfer();
    await act(async () => {
      fireEvent.mouseDown(mention, { clientX: 1, clientY: 1 });
      fireEvent.dragStart(mention, { dataTransfer });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(editor.view.dragging).not.toBeNull();

    editor.view.posAtCoords = () => ({
      pos: editor.state.doc.content.size - 1,
      inside: -1,
    });
    try {
      await act(async () => {
        fireEvent.drop(editor.view.dom, { dataTransfer });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    } finally {
      editor.view.posAtCoords = originalPosAtCoords;
    }

    const atomOrder: string[] = [];
    editor.state.doc.descendants((node) => {
      if (['mentionChip', 'pastedTextChip', 'composerQuote'].includes(node.type.name)) {
        atomOrder.push(
          node.type.name === 'mentionChip'
            ? `${node.type.name}:${String(node.attrs.kind)}`
            : node.type.name,
        );
      }
    });
    expect(atomOrder).toEqual([
      'mentionChip:plugin-capability',
      'pastedTextChip',
      'composerQuote',
      'mentionChip:file',
    ]);
  });
});

function countComposerQuotes(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'composerQuote') count += 1;
  });
  return count;
}

function QuoteRemoveHarness({ onEditor }: { onEditor?: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History, ComposerQuoteNode],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            {
              type: 'composerQuote',
              attrs: { text: 'same', sourcePath: 'src/a.ts', startLine: 1, endLine: 2 },
            },
            { type: 'text', text: ' mid ' },
            {
              type: 'composerQuote',
              attrs: { text: 'same', sourcePath: 'src/a.ts', startLine: 1, endLine: 2 },
            },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    },
    onCreate: ({ editor: createdEditor }) => onEditor?.(createdEditor),
  });

  return <EditorContent editor={editor} />;
}

describe('composer quote remove control', () => {
  afterEach(() => {
    cleanup();
  });

  async function renderQuoteHarness() {
    let activeEditor: Editor | null = null;
    const view = render(
      <QuoteRemoveHarness
        onEditor={(editor) => {
          activeEditor = editor;
        }}
      />,
    );
    const editor = await waitFor(() => {
      if (!activeEditor) throw new Error('Composer editor was not created');
      return activeEditor;
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-composer-quote]').length).toBe(2),
    );
    return { editor, ...view };
  }

  it('uses a real button with a localized accessible name and a shared Tip, not native title', async () => {
    const { container } = await renderQuoteHarness();
    const wrapper = container.querySelector<HTMLElement>('[data-composer-quote]');
    expect(wrapper).not.toBeNull();
    // 外层 wrapper 必须 relative，absolute 定位的 × 才锚定在本颗胶囊上，
    // 多条引用的关闭钮不会叠到同一处。
    expect(wrapper?.className).toContain('relative');

    const button = wrapper?.querySelector('button');
    expect(button?.getAttribute('type')).toBe('button');
    const label = button?.getAttribute('aria-label') ?? '';
    expect(label).toBeTruthy();
    // 无障碍名走 chat.quote.remove，而不是把整段引用正文塞进去。
    expect(label).not.toContain('same');
    // DESIGN.md §14.6 禁止用 native title 替代共享 Tip。
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.querySelector('svg')).not.toBeNull();

    // hover / focus 显隐契约：默认 opacity-0，group hover 与 focus-visible 显示。
    expect(button?.className).toContain('opacity-0');
    expect(button?.className).toContain('group-hover/quote:opacity-100');
    expect(button?.className).toContain('focus-visible:opacity-100');
  });

  it('removes only the clicked quote when two identical quotes exist', async () => {
    const { editor, container } = await renderQuoteHarness();
    expect(countComposerQuotes(editor)).toBe(2);

    const buttons = container.querySelectorAll<HTMLElement>('[data-composer-quote] button');
    expect(buttons.length).toBe(2);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(countComposerQuotes(editor)).toBe(1));
    await waitFor(() =>
      expect(container.querySelectorAll('[data-composer-quote]').length).toBe(1),
    );
    // 只删了被点的那颗，两侧正文与另一颗引用保持原位。
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
    expect(container.textContent).toContain('same');
  });

  it('restores the quote through undo and redo after removal', async () => {
    const { editor, container } = await renderQuoteHarness();
    const button = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-composer-quote] button');
      if (!element) throw new Error('Remove control was not rendered');
      return element;
    });

    fireEvent.click(button);
    await waitFor(() => expect(countComposerQuotes(editor)).toBe(1));

    await act(async () => {
      editor.commands.undo();
    });
    expect(countComposerQuotes(editor)).toBe(2);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-composer-quote]').length).toBe(2),
    );

    await act(async () => {
      editor.commands.redo();
    });
    expect(countComposerQuotes(editor)).toBe(1);
  });

  it.each(['Enter', ' '] as const)(
    'deletes via %s without bubbling the key event toward send',
    async (key) => {
      const { editor, container } = await renderQuoteHarness();

      // stopPropagation 的目的：Enter/Space 不能冒泡到 ChatInput.handleKeyDown
      // 触发发送。document 上还能听到该 keydown 就说明冒泡没拦住。
      const bubbledKeys: string[] = [];
      const listener = (event: KeyboardEvent) => bubbledKeys.push(event.key);
      document.addEventListener('keydown', listener);

      try {
        const button = await waitFor(() => {
          const element = container.querySelector<HTMLElement>('[data-composer-quote] button');
          if (!element) throw new Error('Remove control was not rendered');
          return element;
        });

        fireEvent.keyDown(button, { key });
        expect(bubbledKeys).not.toContain(key);
        await waitFor(() => expect(countComposerQuotes(editor)).toBe(1));
      } finally {
        document.removeEventListener('keydown', listener);
      }
    },
  );

  it('does not remove the quote while the editor is locked (not editable)', async () => {
    const { editor, container } = await renderQuoteHarness();
    const button = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-composer-quote] button');
      if (!element) throw new Error('Remove control was not rendered');
      return element;
    });

    await act(async () => {
      editor.setEditable(false);
    });
    fireEvent.click(button);
    expect(countComposerQuotes(editor)).toBe(2);

    await act(async () => {
      editor.setEditable(true);
    });
    fireEvent.click(button);
    await waitFor(() => expect(countComposerQuotes(editor)).toBe(1));
  });
});
