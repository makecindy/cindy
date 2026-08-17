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
import {
  findHostCapabilityChipMatch,
  placeGhostAtComposerStart,
  placeHostCapabilityAtComposerStart,
} from '@/components/new-chat/ghostComposerPlacement';
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
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function hostCapabilityGhost(id = 'ios-simulator'): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: 'iOS Simulator',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['ios-simulator'],
    },
    dir: `/tmp/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
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

  it('replaces a Host capability chip instead of stacking Plugin invocations', () => {
    const capability = hostCapabilityGhost();
    const selected = ghost('feishu');
    const editor = editorWith('继续补充需求');
    placeHostCapabilityAtComposerStart(editor, capability, [capability, selected]);

    expect(placeGhostAtComposerStart(editor, selected, [capability, selected])).toBe(true);
    expect(editor.getText()).toBe('$feishu 继续补充需求');
    expect(findHostCapabilityChipMatch(editor.state.doc)).toBeNull();
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

describe('placeHostCapabilityAtComposerStart', () => {
  it('prepends an atomic Plugin capability chip and preserves existing text', () => {
    const selected = hostCapabilityGhost();
    const editor = editorWith('帮我调试登录流程');

    expect(placeHostCapabilityAtComposerStart(editor, selected, [selected])).toBe(true);
    const match = findHostCapabilityChipMatch(editor.state.doc);
    expect(match?.attrs).toMatchObject({
      kind: 'plugin-capability',
      label: 'iOS Simulator',
      path: 'ios-simulator',
      pluginId: 'ios-simulator',
      sourceLabel: 'iOS Simulator',
    });
    expect(editor.getText()).toBe(' 帮我调试登录流程');
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size - 1);
  });

  it('replaces an existing command and keeps a single invocation at message start', () => {
    const oldPlugin = ghost('mivo');
    const selected = hostCapabilityGhost();
    const editor = editorWith('$mivo 继续补充需求');

    expect(placeHostCapabilityAtComposerStart(editor, selected, [oldPlugin, selected])).toBe(true);
    expect(findHostCapabilityChipMatch(editor.state.doc)?.attrs.pluginId).toBe('ios-simulator');
    expect(editor.getText()).toBe(' 继续补充需求');
  });

  it('replaces an existing Host capability chip instead of stacking atoms', () => {
    const first = hostCapabilityGhost('ios-simulator-old');
    const selected = hostCapabilityGhost();
    const editor = editorWith('正文');
    placeHostCapabilityAtComposerStart(editor, first, [first, selected]);

    expect(placeHostCapabilityAtComposerStart(editor, selected, [first, selected])).toBe(true);
    let capabilityCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'mentionChip' && node.attrs.kind === 'plugin-capability') {
        capabilityCount += 1;
      }
    });
    expect(capabilityCount).toBe(1);
    expect(findHostCapabilityChipMatch(editor.state.doc)?.attrs.pluginId).toBe('ios-simulator');
  });
});
