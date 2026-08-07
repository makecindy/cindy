import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

describe('compact composer typography', () => {
  it('scales named text size line heights with the UI font settings', () => {
    const compactComposerBlock = globalsSource.match(
      /\.chat-rail-compact \[data-chat-input-root\][\s\S]*?\/\* Tiptap ChatInput/,
    )?.[0];
    expect(compactComposerBlock).toBeDefined();

    for (const token of ['xs', 'sm', 'base', 'lg']) {
      expect(compactComposerBlock).toContain(`line-height: var(--text-${token}-line-height);`);
    }
    expect(compactComposerBlock).not.toMatch(/line-height:\s*1(?:rem|\.25rem|\.5rem|\.75rem);/);
  });
});
