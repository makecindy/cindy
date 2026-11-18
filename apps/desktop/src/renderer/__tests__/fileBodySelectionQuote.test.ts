// @vitest-environment jsdom

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createElement, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileBodyView } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent } from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL } from '../../shared/selectionContextMenu';
import '../../preload/sidebarWindowPreload';

const preloadMocks = vi.hoisted(() => ({
  expose: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  fileEvents: new Set<(event: { workdir: string; relPath: string }) => void>(),
  listeners: new Map<string, Set<(event: unknown, ...payload: unknown[]) => void>>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: preloadMocks.expose },
  ipcRenderer: {
    sendSync: vi.fn(() => null),
    on: (channel: string, listener: (event: unknown, ...payload: unknown[]) => void) => {
      if (!preloadMocks.listeners.has(channel)) preloadMocks.listeners.set(channel, new Set());
      preloadMocks.listeners.get(channel)!.add(listener);
    },
    removeListener: (channel: string, listener: (event: unknown, ...payload: unknown[]) => void) =>
      preloadMocks.listeners.get(channel)?.delete(listener),
  },
}));

function emitAddToChat() {
  for (const listener of preloadMocks.listeners.get(SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL) ?? []) {
    listener({ sender: 'must stay in preload' }, 'unexpected payload');
  }
}

vi.mock('react-i18next', () => {
  const t = (key: string, values?: { message?: string }) => values?.message ? `${key}: ${values.message}` : key;
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
// These media/host branches do not participate in text selection or quoting.
vi.mock('@/components/markdown/MermaidLightboxHost', () => ({ MermaidLightboxHost: () => null }));
vi.mock('@/components/markdown/MermaidSourceEditor', () => ({ MermaidSourceEditorHost: () => null }));
vi.mock('@/components/markdown/MarkdownImageLightboxHost', () => ({ MarkdownImageLightboxHost: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/ImagePreview', () => ({ ImagePreview: ({ src, relPath }: { src: string; relPath: string }) => createElement('img', { src, alt: relPath }) }));
vi.mock('@/features/cc-agent/workdir-browse/PdfPreview', () => ({ PdfPreview: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/DrawioPreview', () => ({ DrawioPreview: () => null }));
vi.mock('@/lib/fileBrowserTransport', () => ({
  fileBrowserApiFor: () => ({ writeFile: preloadMocks.writeFile, readFile: preloadMocks.readFile }),
  onFileTreeEventFor: (_deviceId: unknown, listener: (event: { workdir: string; relPath: string }) => void) => {
    preloadMocks.fileEvents.add(listener);
    return () => preloadMocks.fileEvents.delete(listener);
  },
}));

const sessionId = 'file-body-selection-quote';
const workdir = resolve(tmpdir(), 'cindy-file-body-selection-quote');
const rect = new DOMRect(120, 100, 160, 20);
const rangeDescriptors = {
  getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects'),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect'),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
  // Use the real detached-window bridge: a hand-written stub hid Issue #6655.
  vi.stubGlobal('electronAPI', preloadMocks.expose.mock.calls.find(([name]) => name === 'electronAPI')![1]);
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
  // Issue #6655: the sidebar preload lacked the subscription required at mount.
  // Unit tier, no Electron process: exercise its exposed bridge and FileBodyView
  // together. Existing button-only coverage supplied the missing API in a mock.
  // Minimal failure: mount one text document with the actual sidebar bridge.
  it.each(['button', 'native menu'])('adds the source slice, path and lines through the %s', (action) => {
    const tableSource = '| Name | Value |\n| --- | --- |\n| Ada | 1 |';
    const source = '# Notes\n\n' + tableSource + '\n\nAfter';
    const { container, unmount } = render(createElement(FileBodyView, {
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
    if (action === 'button') {
      const quoteButton = screen.getByRole('button', { name: 'chat.quote.addToChat' });
      fireEvent.mouseDown(quoteButton);
      fireEvent.click(quoteButton);
    } else {
      act(emitAddToChat);
    }

    expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
      {
        type: 'composerQuote',
        attrs: { text: tableSource, sourcePath: 'notes.md', startLine: 3, endLine: 5 },
      },
    ]);
    expect(selection.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.quote.addToChat' })).toBeNull();
    unmount();
    expect(preloadMocks.listeners.get(SELECTION_CONTEXT_MENU_ADD_TO_CHAT_CHANNEL)?.size).toBe(0);
  });

  it('keeps native-menu subscribers independent, strips IPC arguments and stops after unsubscribe', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = window.electronAPI.onSelectionContextMenuAddToChat(first);
    const offSecond = window.electronAPI.onSelectionContextMenuAddToChat(second);
    emitAddToChat();
    expect(first.mock.calls).toEqual([[]]);
    expect(second.mock.calls).toEqual([[]]);
    offFirst();
    emitAddToChat();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
    emitAddToChat();
    expect(second).toHaveBeenCalledTimes(2);
  });
});

// SVG file clicks previously exposed only XML. Unit tier: use the real file body
// and editor to cover default presentation and retaining unsaved source edits;
// existing selection tests exercise Markdown only.
it('previews SVG by default and retains source edits across preview toggles', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>before</text></svg>';
  const props = {
    workdir, relPath: 'drawing.svg',
    content: { kind: 'text' as const, relPath: 'drawing.svg', content: source, size: source.length, mtimeMs: 0, truncated: false },
  };
  const { container, rerender } = render(createElement(FileBodyView, props));
  expect(decodeURIComponent(screen.getByRole('img').getAttribute('src')!)).toContain(source);
  fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.source' }));
  expect(screen.queryByRole('img')).toBeNull();
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
  const updated = source.replace('before', 'after');
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: updated } }));
  fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.rendered' }));
  expect(decodeURIComponent(screen.getByRole('img').getAttribute('src')!)).toContain(updated);
  fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.source' }));
  expect(view.state.doc.toString()).toBe(updated);
  // Search navigation still opens the source, but its consumed parameters must
  // not permanently prevent returning to the rendered image.
  rerender(createElement(FileBodyView, { ...props, jumpQuery: 'text', jumpLine: 1 }));
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'attachmentPreview.rendered' }));
  expect(screen.getByRole('img')).toBeTruthy();
});

// #10882 review: core rejects a retargeted save, but the editor must retain
// the target of its dirty baseline rather than adopt a watcher reload's target.
// Unit through real FileBodyView/CodeMirror/save handle; no existing quote test
// covered writes. Minimal input: dirty A draft followed by a B content prop.
// Windows acceptance also found that the error advised an impossible overwrite.
// Cover the visible reason for manual saves and autosave's earlier conflict guard.
it.each([
  { mode: 'manual', target: 'b/note.md', reason: 'targetChanged' },
  { mode: 'autosave', target: 'b/note.md', reason: 'targetChanged' },
  { mode: 'autosave', target: 'a/note.md', reason: 'externalChangeBlocked' },
])('retains the draft and explains $reason on $mode', async ({ mode, target, reason }) => {
  preloadMocks.writeFile.mockClear();
  const ref = createRef<import('@/features/cc-agent/workdir-browse/FileBodyView').FileBodyHandle>();
  const props = {
    workdir, relPath: 'alias/note.md', ref,
    content: { kind: 'text' as const, relPath: 'alias/note.md', content: 'A',
      size: 1, mtimeMs: 1, truncated: false, resolvedPath: 'a/note.md' },
  };
  const { container, rerender } = render(createElement(FileBodyView, props));
  const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
  act(() => { editor.dispatch({ changes: { from: 1, insert: ' edited' } }); });
  rerender(createElement(FileBodyView, { ...props,
    content: { ...props.content, content: 'B', resolvedPath: target },
  }));
  if (mode === 'manual') {
    preloadMocks.writeFile.mockResolvedValueOnce({ ok: false, message: 'FILE_TARGET_CHANGED' });
    await act(async () => { expect(await ref.current!.save()).toBe(false); });
    expect(preloadMocks.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({
      content: 'A edited', expectedResolvedPath: 'a/note.md',
    }));
  } else {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(preloadMocks.writeFile).not.toHaveBeenCalled();
  }
  expect(editor.state.doc.toString()).toBe('A edited');
  expect(ref.current!.isDirty()).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('ccAgent.workdirBrowse.fileBody.saveFailed');
  expect(screen.getByRole('alert').textContent).toContain(`ccAgent.workdirBrowse.fileBody.${reason}`);
});

// #10882 discussion_r4599374914: a truncated watcher reload unmounted the dirty
// editor to fetch the large file. Existing prop-only tests miss the hook's
// loading transition. Unit through useFileContent + real FileBodyView/CodeMirror:
// edit small A, receive an alias event pointing to large B, then save and reopen.
it.each(['ssh', 'device'])('preserves the dirty editor when %s retargets to a large file', async (transport) => {
  const remoteHostId = transport === 'ssh' ? 'test-host' : null;
  const deviceId = transport === 'device' ? 'test-device' : null;
  const relPath = 'alias/large.md';
  const small = { relPath, content: 'A', size: 1, mtimeMs: 1, truncated: false, resolvedPath: 'a/large.md' };
  const large = { ...small, content: 'B', size: 3 * 1024 * 1024, truncated: true, resolvedPath: 'b/large.md' };
  preloadMocks.readFile.mockReset().mockResolvedValueOnce({ ok: true, data: small })
    .mockResolvedValue({ ok: true, data: large });
  preloadMocks.writeFile.mockReset().mockResolvedValue({ ok: false, message: 'FILE_TARGET_CHANGED' });
  const fetchRemote = vi.fn().mockResolvedValue({ ok: true, cachePath: resolve(workdir, 'large-cache.md') });
  vi.stubGlobal('electronAPI', {
    ...window.electronAPI,
    fileBrowser: {
      ...window.electronAPI.fileBrowser, cachePut: vi.fn(), fetchRemote,
      readCached: vi.fn().mockResolvedValue({ ok: true, content: 'B', truncated: true }),
    },
  });
  const ref = createRef<import('@/features/cc-agent/workdir-browse/FileBodyView').FileBodyHandle>();
  function Preview() {
    const { content } = useFileContent(workdir, relPath, remoteHostId, deviceId);
    return createElement(FileBodyView, { workdir, relPath, remoteHostId, deviceId, ref, content });
  }
  const mounted = render(createElement(Preview));
  await act(async () => {});
  const editorNode = mounted.container.querySelector<HTMLElement>('.cm-editor')!;
  const editor = EditorView.findFromDOM(editorNode)!;
  act(() => { editor.dispatch({ changes: { from: 1, insert: ' edited' } }); });
  await act(async () => {
    for (const listener of preloadMocks.fileEvents) listener({ workdir, relPath: 'alias' });
  });
  expect(mounted.container.querySelector('.cm-editor')).toBe(editorNode);
  expect(editor.state.doc.toString()).toBe('A edited');
  expect(ref.current!.isDirty()).toBe(true);
  expect(fetchRemote).not.toHaveBeenCalled();
  await act(async () => { expect(await ref.current!.save()).toBe(false); });
  expect(preloadMocks.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({
    remoteHostId, content: 'A edited', expectedResolvedPath: 'a/large.md',
  }));
  expect(screen.getByRole('alert').textContent).toContain('ccAgent.workdirBrowse.fileBody.targetChanged');
  expect(editor.state.doc.toString()).toBe('A edited');
  mounted.unmount();
  render(createElement(Preview));
  await act(async () => {});
  expect(fetchRemote).toHaveBeenCalledTimes(1);
  expect(fetchRemote).toHaveBeenCalledWith(expect.objectContaining({ relPath, size: large.size, remoteHostId, deviceId }));
});
