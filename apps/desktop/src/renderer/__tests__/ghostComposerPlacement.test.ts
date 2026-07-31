// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
} from '@/components/new-chat/ComposerListNodes';
import { placeGhostAtComposerStart } from '@/components/new-chat/ghostComposerPlacement';
import { MentionChipNode } from '@/components/new-chat/MentionChipNode';
import type { InstalledGhost } from '../../shared/ghost';

const editors: Editor[] = [];

function ghost(command: string, id = command, enabled = true): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'run', description: 'Run.' }],
      command,
    },
    dir: `/tmp/${id}`,
    enabled,
  };
}

function editorWith(content: string): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, MentionChipNode],
    content,
  });
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
});

describe('placeGhostAtComposerStart', () => {
  it('prepends the Plugin command, preserves existing text, and focuses the end', () => {
    const editor = editorWith('继续补充需求');
    const selected = ghost('mivo');

    expect(placeGhostAtComposerStart(editor, selected, [selected])).toBe(true);
    expect(editor.getText()).toBe('$mivo 继续补充需求');
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size - 1);
  });

  it('replaces an existing Plugin command instead of stacking commands', () => {
    const current = ghost('mivo');
    const selected = ghost('feishu');
    const editor = editorWith('$mivo 帮我整理这段内容');

    placeGhostAtComposerStart(editor, selected, [current, selected]);

    expect(editor.getText()).toBe('$feishu 帮我整理这段内容');
  });

  it('replaces an installed command even when the old Plugin is disabled', () => {
    const disabledCurrent = ghost('mivo', 'mivo', false);
    const selected = ghost('feishu');
    const editor = editorWith('$mivo 帮我整理这段内容');

    placeGhostAtComposerStart(editor, selected, [disabledCurrent, selected]);

    expect(editor.getText()).toBe('$feishu 帮我整理这段内容');
  });

  it('adds a command paragraph before a leading structured list', () => {
    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerListItem,
        ComposerBulletList,
        ComposerOrderedList,
        MentionChipNode,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'first' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    const selected = ghost('mivo');

    expect(placeGhostAtComposerStart(editor, selected, [selected])).toBe(true);
    expect(editor.getJSON().content).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '$mivo ' }],
      },
      {
        type: 'bulletList',
        attrs: { marker: '-', separator: ' ' },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'first' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('does not replace a command that appears after leading list content', () => {
    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerListItem,
        ComposerBulletList,
        ComposerOrderedList,
        MentionChipNode,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'first' }],
                  },
                ],
              },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '$old later text' }],
          },
        ],
      },
    });
    editors.push(editor);

    expect(placeGhostAtComposerStart(editor, ghost('mivo'), [ghost('mivo'), ghost('old')])).toBe(
      true,
    );
    expect(editor.getJSON().content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '$mivo ' }],
    });
    expect(editor.getJSON().content?.[2]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '$old later text' }],
    });
  });

  it('does not replace a command that appears after an empty structured list', () => {
    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerListItem,
        ComposerBulletList,
        ComposerOrderedList,
        MentionChipNode,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '$old later text' }],
          },
        ],
      },
    });
    editors.push(editor);

    expect(placeGhostAtComposerStart(editor, ghost('mivo'), [ghost('mivo'), ghost('old')])).toBe(
      true,
    );
    expect(editor.getJSON().content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '$mivo ' }],
    });
    expect(editor.getJSON().content?.[1]?.type).toBe('bulletList');
  });
});
