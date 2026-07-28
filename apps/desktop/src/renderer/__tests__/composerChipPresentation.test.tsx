// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
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
    const alignmentRule = globalsSource.match(
      /\.ProseMirror :is\(\[data-mention-chip\], \[data-pasted-text-chip\], \[data-composer-quote\]\) \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(alignmentRule).toContain('position: relative');
    expect(alignmentRule).toContain('top: -1px');
  });

  it('keeps the caret and prose 4px away from every composer pill', () => {
    const gapRule = globalsSource.match(
      /\.ProseMirror :is\(\s*\[data-mention-chip\],\s*\[data-pasted-text-chip\],\s*\[data-composer-quote\],\s*\.ghost-cmd-pill,\s*\.slash-cmd-pill,\s*\.quick-start-pill\s*\) \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(gapRule).toContain('margin-inline: 4px');
  });

  it('gives every atom the shared pill and a non-selecting native drag handle', async () => {
    const { container } = render(<ComposerHarness />);
    const atoms = await waitFor(() => {
      const renderedAtoms = [
        container.querySelector<HTMLElement>('[data-mention-chip]'),
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
      expect(atom?.querySelector('button')).toBeNull();
    }
    expect(container.querySelector('[data-mention-chip][data-kind="slash"]')).toBeNull();
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
      const element = container.querySelector<HTMLElement>('[data-mention-chip]');
      if (!element) throw new Error('Mention atom was not rendered');
      return element;
    });

    let mentionPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'mentionChip') return true;
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
        atomOrder.push(node.type.name);
      }
    });
    expect(atomOrder).toEqual(['pastedTextChip', 'composerQuote', 'mentionChip']);
  });
});
