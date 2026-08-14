// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { MentionChipNode } from '@/components/new-chat/MentionChipNode';

const mounted: Array<{ editor: Editor; host: HTMLDivElement }> = [];

afterEach(() => {
  for (const { editor, host } of mounted.splice(0)) {
    editor.destroy();
    host.remove();
  }
});

function renderSessionChip(href: string, label = 'Fix white screen'): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
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
                kind: 'session',
                label,
                path: href,
                titled: true,
              },
            },
          ],
        },
      ],
    },
  });
  mounted.push({ editor, host });
  const chip = host.querySelector<HTMLElement>('[data-mention-chip]');
  if (!chip) throw new Error('Session chip was not rendered');
  return chip;
}

describe('composer session-link chip presentation', () => {
  it('keeps a whole-conversation link as the conversation title', () => {
    const chip = renderSessionChip('cindy://session/session-1');

    expect(chip.textContent).toBe('Fix white screen');
    expect(chip.querySelector('path')?.getAttribute('d')).toBe('M15 10l5 5-5 5');
  });

  it('shows the message excerpt directly and keeps the full text on hover', () => {
    const chip = renderSessionChip(
      'cindy://session/session-1?message=client-1',
      'First line\n\nsecond line',
    );

    expect(chip.textContent).toBe('First line second line');
    expect(chip.getAttribute('title')).toBeNull();
    expect(chip.getAttribute('aria-label')).toBe('First line\n\nsecond line');
    expect(chip.className).toContain('rounded-full');
    expect(chip.className).toContain('text-12');
    expect(chip.className).toContain('border-[var(--border-default)]');
    expect(chip.querySelector('path')?.getAttribute('d')).toBe(
      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    );
  });
});
