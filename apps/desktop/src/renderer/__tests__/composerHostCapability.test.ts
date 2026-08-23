// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { expandGhostCommand } from '@/cindy-brain/ghostCommand';
import {
  expandHostCapabilityInvocation,
  splitHostCapabilityDirective,
} from '@/cindy-brain/hostCapabilityInvocation';
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
      slots: ['ios-simulator'],
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
  it('serializes as routing metadata rather than an automatic visible prefix', async () => {
    await i18n.changeLanguage('zh-CN');
    const serialized = serializeEditorContent(editorWithCapability());

    expect(serialized.text).toBe('');
    expect(serialized.hostCapability).toEqual({
      capability: 'ios-simulator',
      ghostId: 'ios-simulator',
      name: 'iOS Simulator',
    });
    expect(serialized.mentions).toEqual([]);
    expect(serialized.agentReferences).toEqual([]);
    expect(expandGhostCommand(serialized.text, [capabilityGhost()])).toBe(serialized.text);
    expect(serialized.text).not.toContain('ghost_call');
  });

  it('keeps user text once and appends a parseable Host route without ghost_call routing', () => {
    const serialized = serializeEditorContent(
      editorWithCapability('ios-simulator', 'iOS Simulator', '帮我打开iOS模拟器，调试当前项目'),
    );
    expect(serialized.text).toBe('帮我打开iOS模拟器，调试当前项目');

    const expanded = expandHostCapabilityInvocation(
      serialized.text,
      serialized.hostCapability!,
      '帮我打开 iOS 模拟器。',
    );
    const split = splitHostCapabilityDirective(expanded);
    expect(split?.body).toBe('帮我打开iOS模拟器，调试当前项目');
    expect(split?.directive).toMatchObject({
      kind: 'host-capability',
      capability: 'ios-simulator',
      route: 'cindy_ios_simulator',
      ghostId: 'ios-simulator',
    });
    expect(expanded.match(/帮我打开/g)).toHaveLength(1);
    expect(expanded).toContain('不要通过 ghost_call 调用');
    expect(expanded).not.toContain('必须通过 cindy 总机的 ghost_call');
  });

  it('uses one default prompt when the chip is sent by itself', () => {
    const serialized = serializeEditorContent(editorWithCapability());
    const expanded = expandHostCapabilityInvocation(
      serialized.text,
      serialized.hostCapability!,
      '帮我打开 iOS 模拟器。',
    );
    expect(splitHostCapabilityDirective(expanded)?.body).toBe('帮我打开 iOS 模拟器。');
  });

  it('preserves an unknown future capability as structured metadata', () => {
    expect(
      serializeEditorContent(editorWithCapability('future-capability', 'Future')).hostCapability,
    ).toEqual({
      capability: 'future-capability',
      ghostId: 'ios-simulator',
      name: 'iOS Simulator',
    });
  });
});
