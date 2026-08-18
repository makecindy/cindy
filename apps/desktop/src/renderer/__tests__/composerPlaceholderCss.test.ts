import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

describe('composer placeholder CSS', () => {
  it('renders the placeholder when Tiptap leaves only the empty-node class', () => {
    expect(globalsSource).toContain(
      '.ProseMirror > p.is-empty:first-child:only-child::before {',
    );
  });

  it('keeps the empty-node fallback hidden while a voice draft is active', () => {
    expect(globalsSource).toContain(
      "[data-voice-draft-active='true'] .ProseMirror > p.is-empty:first-child:only-child::before {",
    );
  });

  it('keeps the native placeholder hidden while a recommendation overlay is active (is-empty fallback included)', () => {
    expect(globalsSource).toContain(
      "[data-recommendation-active='true'] .ProseMirror > p.is-empty:first-child:only-child::before {",
    );
  });
});
