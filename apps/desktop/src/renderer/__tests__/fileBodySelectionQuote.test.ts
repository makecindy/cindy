// @vitest-environment jsdom

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileBodyView } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { clearDraft, getDraft } from '@/lib/composerDraftStore';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
// These media/host branches do not participate in text selection or quoting.
vi.mock('@/components/markdown/MermaidLightboxHost', () => ({ MermaidLightboxHost: () => null }));
vi.mock('@/components/markdown/MermaidSourceEditor', () => ({ MermaidSourceEditorHost: () => null }));
vi.mock('@/components/markdown/MarkdownImageLightboxHost', () => ({ MarkdownImageLightboxHost: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/PdfPreview', () => ({ PdfPreview: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/DrawioPreview', () => ({ DrawioPreview: () => null }));
vi.mock('@/lib/fileBrowserTransport', () => ({ fileBrowserApiFor: () => ({}) }));

const sessionId = 'file-body-selection-quote';
const workdir = resolve(tmpdir(), 'cindy-file-body-selection-quote');
const rect = new DOMRect(120, 100, 160, 20);
const rangeDescriptors = {
  getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects'),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect'),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.stubGlobal('electronAPI', {
    onSelectionContextMenuAddToChat: () => () => {},
  });
  // jsdom has real ranges/selections but no layout. Supply geometry only;
  // neither CodeMirror's selection state nor DOM selection text is mocked.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true, value: () => [rect],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true, value: () => rect,
  });
});

afterEach(() => {
  cleanup();
  clearDraft(sessionId);
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of Object.entries(rangeDescriptors)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
});

// PR #6196 discussion_r4293711863 / engineering-conventions §3.2: the former
// source scan could not detect DOM text replacing the selected document slice.
// chatQuotes and selectionQuoteUserMessage cover formatting/message ownership,
// not FileBodyView -> real CodeMirror -> quote action -> composer draft. Restore
// this module's original unit file because it owns an editor/DOM lifecycle absent
// from those helper tests. Minimal input: one rendered Markdown table whose DOM
// text differs from its selected source, followed by one Add to chat click.
describe('FileBodyView selection quotes', () => {
  it('adds the CodeMirror source slice, path and line range instead of rendered widget text', () => {
    const tableSource = '| Name | Value |\n| --- | --- |\n| Ada | 1 |';
    const source = '# Notes\n\n' + tableSource + '\n\nAfter';
    const { container } = render(createElement(FileBodyView, {
      workdir,
      sessionId,
      relPath: 'notes.md',
      content: {
        kind: 'text', relPath: 'notes.md', content: source,
        size: source.length, mtimeMs: 0, truncated: false,
      },
    }));
    const editor = container.querySelector<HTMLElement>('.cm-editor')!;
    const view = EditorView.findFromDOM(editor)!;
    const table = screen.getByRole('table');
    const from = source.indexOf(tableSource);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: from, head: from + tableSource.length } });
      // Settle CodeMirror's own DOM selection write before selecting its widget.
      vi.advanceTimersByTime(32);
    });

    const domRange = document.createRange();
    domRange.selectNodeContents(table);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(domRange);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.empty).toBe(false);
    expect(selection.toString()).toContain('Ada');
    expect(selection.toString()).not.toBe(tableSource);

    fireEvent.mouseUp(table);
    act(() => { vi.advanceTimersByTime(16); });
    expect(selection.isCollapsed).toBe(false);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.empty).toBe(false);
    expect(selection.toString()).not.toBe(tableSource);
    const quoteButton = screen.getByRole('button', { name: 'chat.quote.addToChat' });
    fireEvent.mouseDown(quoteButton);
    fireEvent.click(quoteButton);

    expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
      {
        type: 'composerQuote',
        attrs: { text: tableSource, sourcePath: 'notes.md', startLine: 3, endLine: 5 },
      },
    ]);
    expect(selection.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.quote.addToChat' })).toBeNull();
  });
});
