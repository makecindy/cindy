// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { expandGhostCommand } from '@/cindy-brain/ghostCommand';

import { serializeEditorContent } from '@/components/new-chat/composerContentSerialization';
import { MentionChipNode } from '@/components/new-chat/MentionChipNode';
import { i18n } from '@/i18n';
import type { InstalledGhost } from '../../shared/ghost';

const editors: Editor[] = [];
const initialLanguage = i18n.language;

function capabilityGhost(): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'ios-simulator',
      name: 'iOS Simulator',
      version: '0.2.0',
      kind: 'chip',
      entry: 'main.js',
      iosSimulator: true,
    },
    dir: '/tmp/ios-simulator',
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function editorWithCapability(path = 'ios-simulator', label = 'iOS Simulator', body = ''): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, MentionChipNode],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mentionChip',
              attrs: {
                kind: 'plugin-capability',
                label,
                path,
                pluginId: 'ios-simulator',
                sourceLabel: 'iOS Simulator',
              },
            },
            ...(body ? [{ type: 'text', text: ` ${body}` }] : []),
          ],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy();
  await i18n.changeLanguage(initialLanguage);
});

describe('Host capability composer chip', () => {
  it('ignores a retired chip when sending the remaining user text', () => {
    const serialized = serializeEditorContent(editorWithCapability('ios-simulator', 'iOS Simulator', '继续整理文件'));
    expect(serialized.text.trim()).toBe('继续整理文件');
    expect(serialized).not.toHaveProperty('hostCapability');
    expect(serialized.mentions).toEqual([]);
  });

  it('does not turn a chip-only old draft into a callable route or plugin command', () => {
    const serialized = serializeEditorContent(editorWithCapability());
    expect(serialized.text).toBe('');
    expect(serialized).not.toHaveProperty('hostCapability');
    expect(serialized.mentions).toEqual([]);
    expect(serialized.agentReferences).toEqual([]);
    expect(expandGhostCommand(serialized.text, [capabilityGhost()])).toBe('');
  });
});
