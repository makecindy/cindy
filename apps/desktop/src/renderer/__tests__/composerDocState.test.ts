// @vitest-environment jsdom
// (Editor 构造需要 DOM。)
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import {
  composerDocIsEmpty,
  docContainsAtomChip,
  docContainsStructuredList,
} from '@/components/new-chat/composerDocState';
import { ComposerBulletList, ComposerListItem } from '@/components/new-chat/ComposerListNodes';
import { ComposerQuoteNode } from '@/components/new-chat/ComposerQuoteNode';
import { MentionChipNode } from '@/components/new-chat/MentionChipNode';
import { PastedTextChipNode } from '@/components/new-chat/PastedTextChipNode';

// Editor 必须逐个 destroy:EditorView 的异步回调会在 jsdom 环境拆除后触发
// `document is not defined` 未处理异常,vitest 全绿也会 exit 1(CI 实撞)。
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      ComposerListItem,
      ComposerBulletList,
      MentionChipNode,
      PastedTextChipNode,
      ComposerQuoteNode,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  });
  editors.push(editor);
  return editor;
}

describe('composerDocState', () => {
  it('treats a truly empty / whitespace-only doc as empty', () => {
    const editor = makeEditor();
    expect(composerDocIsEmpty(editor.state.doc)).toBe(true);
    editor.commands.insertContent('   ');
    expect(composerDocIsEmpty(editor.state.doc)).toBe(true);
    expect(docContainsAtomChip(editor.state.doc)).toBe(false);
  });

  it('treats a doc with text as non-empty', () => {
    const editor = makeEditor();
    editor.commands.insertContent('draft');
    expect(composerDocIsEmpty(editor.state.doc)).toBe(false);
  });

  it('treats an empty structured list item as non-empty content', () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
      ],
    });
    expect(docContainsStructuredList(editor.state.doc)).toBe(true);
    expect(composerDocIsEmpty(editor.state.doc)).toBe(false);
  });

  it('treats a chip-only doc as non-empty (review P2)', () => {
    // atom chip 无文本投影,textContent 判空会把只含 chip 的草稿误当空,
    // ↑ 历史回填 replaceWith 整段覆盖丢 payload。
    const pasted = makeEditor();
    pasted.commands.insertContent({
      type: 'pastedTextChip',
      attrs: { text: 'a\nb\nc', display: '粘贴的文本(3 行)' },
    });
    expect(pasted.state.doc.textContent.trim()).toBe(''); // 前提:无文本投影
    expect(docContainsAtomChip(pasted.state.doc)).toBe(true);
    expect(composerDocIsEmpty(pasted.state.doc)).toBe(false);

    const mention = makeEditor();
    mention.commands.insertContent({
      type: 'mentionChip',
      attrs: { kind: 'file', label: 'main.ts', path: 'src/main.ts' },
    });
    expect(docContainsAtomChip(mention.state.doc)).toBe(true);
    expect(composerDocIsEmpty(mention.state.doc)).toBe(false);

    const quote = makeEditor();
    quote.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: {
                text: 'quoted',
                sourcePath: null,
                startLine: null,
                endLine: null,
              },
            },
          ],
        },
      ],
    });
    expect(docContainsAtomChip(quote.state.doc)).toBe(true);
    expect(composerDocIsEmpty(quote.state.doc)).toBe(false);
  });
});
