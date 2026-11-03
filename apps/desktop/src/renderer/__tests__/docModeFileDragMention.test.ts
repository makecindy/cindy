import { Editor, type Extensions, type JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_MENTION_MIME,
  decodeComposerMentionPayload,
  encodeComposerMentionPayload,
} from '@/lib/composerMentionDrag';
import { consumeComposerMentionDrop } from '@/lib/composerDrop';
import {
  MentionChipNode,
  type MentionChipAttrs,
} from '@/components/new-chat/MentionChipNode';
import {
  getMentionDragCaretPosition,
  MentionDragCaretDecoration,
  setMentionDragCaret,
} from '@/components/new-chat/MentionDragCaretDecoration';
import { appendMentionChip } from '@/components/new-chat/mentionChipInsertion';

function makeEditor(text: string): Editor {
  return makeEditorWithExtensions(text, [Document, Paragraph, Text, MentionChipNode]);
}

function makeEditorWithExtensions(text: string, extensions: Extensions): Editor {
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: text.length > 0 ? [{ type: 'text', text }] : [],
      },
    ],
  };
  return new Editor({
    extensions,
    content,
  });
}

function makeEditorWithDragCaret(text: string): Editor {
  return makeEditorWithExtensions(text, [
    Document,
    Paragraph,
    Text,
    MentionChipNode,
    MentionDragCaretDecoration,
  ]);
}

// titled 是 session chip 专用 attr,file / dir 用默认 false;fixture 显式写上,
// 让「插入 attrs」与 getJSON 的输出(含默认值)可以直接 toEqual 比对。
const fileMention: MentionChipAttrs = {
  kind: 'file',
  label: 'README.md',
  path: 'docs/README.md',
  titled: false,
};

const directoryMention: MentionChipAttrs = {
  kind: 'dir',
  label: 'docs',
  path: 'docs',
  titled: false,
};

describe('doc mode file and folder drag to mention', () => {
  it('round-trips shared composer mention payloads', () => {
    const encodedFile = encodeComposerMentionPayload({
      type: 'file',
      relPath: 'docs/README.md',
      name: 'README.md',
    });
    const encodedDirectory = encodeComposerMentionPayload({
      type: 'directory',
      relPath: 'docs',
      name: 'docs',
    });

    expect(encodedFile).toBe(
      '{"type":"file","relPath":"docs/README.md","name":"README.md"}',
    );
    expect(decodeComposerMentionPayload(encodedFile)).toEqual({
      type: 'file',
      relPath: 'docs/README.md',
      name: 'README.md',
    });
    expect(encodedDirectory).toBe(
      '{"type":"directory","relPath":"docs","name":"docs"}',
    );
    expect(decodeComposerMentionPayload(encodedDirectory)).toEqual({
      type: 'directory',
      relPath: 'docs',
      name: 'docs',
    });
  });

  it('rejects malformed composer mention payloads', () => {
    expect(decodeComposerMentionPayload('')).toBeNull();
    expect(decodeComposerMentionPayload('{')).toBeNull();
    expect(
      decodeComposerMentionPayload(
        '{"type":"unknown","relPath":"docs","name":"docs"}',
      ),
    ).toBeNull();
    expect(
      decodeComposerMentionPayload(
        '{"type":"file","relPath":"","name":"README.md"}',
      ),
    ).toBeNull();
    expect(
      decodeComposerMentionPayload(
        '{"type":"file","relPath":"docs/README.md","name":""}',
      ),
    ).toBeNull();
  });

  it('consumes a valid drag payload and queues a file mention', () => {
    const addFileMention = vi.fn();
    const addFolderPath = vi.fn();
    const consumed = consumeComposerMentionDrop(
      {
        getData: (type) =>
          type === COMPOSER_MENTION_MIME
            ? encodeComposerMentionPayload({
                type: 'file',
                relPath: 'src/main.ts',
                name: 'main.ts',
              })
            : '',
      },
      { addFileMention, addFolderPath },
    );

    expect(consumed).toBe(true);
    expect(addFileMention).toHaveBeenCalledOnce();
    expect(addFileMention).toHaveBeenCalledWith({
      type: 'file',
      relPath: 'src/main.ts',
      name: 'main.ts',
    });
    expect(addFolderPath).not.toHaveBeenCalled();
  });

  it('consumes a valid directory drag payload and queues a folder mention', () => {
    const addFileMention = vi.fn();
    const addFolderPath = vi.fn();
    const consumed = consumeComposerMentionDrop(
      {
        getData: (type) =>
          type === COMPOSER_MENTION_MIME
            ? encodeComposerMentionPayload({
                type: 'directory',
                relPath: 'src/features',
                name: 'features',
              })
            : '',
      },
      { addFileMention, addFolderPath },
    );

    expect(consumed).toBe(true);
    expect(addFileMention).not.toHaveBeenCalled();
    expect(addFolderPath).toHaveBeenCalledOnce();
    expect(addFolderPath).toHaveBeenCalledWith('src/features', 'task');
  });

  it('ignores invalid drag payloads so native file drop handling can continue', () => {
    const addFileMention = vi.fn();
    const addFolderPath = vi.fn();
    const consumed = consumeComposerMentionDrop(
      { getData: () => '{"type":"file","relPath":"","name":"main.ts"}' },
      { addFileMention, addFolderPath },
    );

    expect(consumed).toBe(false);
    expect(addFileMention).not.toHaveBeenCalled();
    expect(addFolderPath).not.toHaveBeenCalled();
  });

  it('inserts a leading space before a dropped mention when needed', () => {
    const editor = makeEditor('请读');

    appendMentionChip(editor, fileMention);

    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '请读 ' },
            { type: 'mentionChip', attrs: fileMention },
            { type: 'text', text: ' ' },
          ],
        },
      ],
    });
  });

  it('does not add a duplicate leading space after existing whitespace', () => {
    const editor = makeEditor('请读 ');

    appendMentionChip(editor, fileMention);

    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '请读 ' },
            { type: 'mentionChip', attrs: fileMention },
            { type: 'text', text: ' ' },
          ],
        },
      ],
    });
  });

  it('inserts a dropped mention at the requested editor position', () => {
    const editor = makeEditor('readhere');

    appendMentionChip(editor, fileMention, { at: 5 });

    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'read ' },
            { type: 'mentionChip', attrs: fileMention },
            { type: 'text', text: ' here' },
          ],
        },
      ],
    });
  });

  it('does not add a trailing space before an adjacent mention chip', () => {
    const editor = makeEditor('');

    appendMentionChip(editor, directoryMention);
    appendMentionChip(editor, fileMention, { at: 1 });

    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mentionChip', attrs: fileMention },
            { type: 'mentionChip', attrs: directoryMention },
            { type: 'text', text: ' ' },
          ],
        },
      ],
    });
  });

  it('inserts a dropped directory mention as a dir chip', () => {
    const editor = makeEditor('参考 ');

    appendMentionChip(editor, directoryMention);

    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '参考 ' },
            { type: 'mentionChip', attrs: directoryMention },
            { type: 'text', text: ' ' },
          ],
        },
      ],
    });
  });

  it('keeps mention chips draggable so existing chips can be reordered in the composer', () => {
    const editor = makeEditor('');

    expect(editor.schema.nodes.mentionChip.spec.draggable).toBe(true);
  });

  it('tracks and clears the mention drag caret position', () => {
    const editor = makeEditorWithDragCaret('move here');

    setMentionDragCaret(editor, 5);
    expect(getMentionDragCaretPosition(editor)).toBe(5);

    setMentionDragCaret(editor, null);
    expect(getMentionDragCaretPosition(editor)).toBeNull();
  });
});
