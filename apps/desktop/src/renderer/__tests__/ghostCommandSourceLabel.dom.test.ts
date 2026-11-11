// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';

import { CjkPunctDecoration } from '@/components/new-chat/CjkPunctDecoration';
import {
  GhostCommandDecoration,
  setGhostCommandRoster,
} from '@/components/new-chat/GhostCommandDecoration';
import type { GhostCommandSource } from '../../shared/ghostComposer';

/**
 * 同名插件胶囊的来源标签在真实 DOM 里只出现一次:指令词含 CJK 标点时,
 * CjkPunctDecoration 会把同一颗胶囊切成多段,每段都带 data-ghost-cmd-origin,
 * 标签必须只由最后一段的 ::after 渲染(jsdom 不算伪元素,按 globals.css 的
 * 选择器在 DOM 上复核)。
 */

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const ghost = (namespace: string | null): GhostCommandSource => ({
  manifest: { id: 'sites', name: 'Sites', command: '画（图）' },
  enabled: true,
  namespace,
});

describe('ghost command source label in the rendered pill', () => {
  it('renders the label once when CJK punctuation splits the pill', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, HardBreak, GhostCommandDecoration, CjkPunctDecoration],
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '$画（图）/xd 发布' }] }] },
    });
    setGhostCommandRoster(editor, [ghost(null), ghost('xd')], { team: '团队共享' });

    const segments = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('.ghost-cmd-pill[data-ghost-cmd-origin]'),
    );
    // The fixture really splits: otherwise this test would pass without exercising the rule.
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((el) => el.dataset.ghostCmdOrigin === '团队共享')).toBe(true);

    expect(globalsSource).toMatch(
      /\.ghost-cmd-pill\[data-ghost-cmd-origin\]:has\(\+ \.ghost-cmd-pill\)::after\s*\{\s*content:\s*none;?\s*\}/,
    );
    const labelled = segments.filter((el) => !el.matches('.ghost-cmd-pill:has(+ .ghost-cmd-pill)'));
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toBe(segments.at(-1));
  });
});
