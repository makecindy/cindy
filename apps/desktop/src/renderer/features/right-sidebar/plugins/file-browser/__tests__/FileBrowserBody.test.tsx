// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { FileBrowserBody } from '../FileBrowserBody';
import type { FileBrowserState } from '../index';
import '../index';
import { getTabKind } from '../../../registry';
import { saveExpandedSet } from '@/features/cc-agent/workdir-browse/lib/expandedStore';

vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useConfirmSwitchAwayIfDirty', () => ({
  useConfirmSwitchAwayIfDirty: () => async () => true,
}));
afterEach(() => vi.unstubAllGlobals());

function mountBrowser(workdir: string, initial: FileBrowserState, save = (_state: FileBrowserState) => {}) {
  function Tab() {
    const [state, setState] = useState(initial);
    return <FileBrowserBody
      ctx={{ sessionId: '', tabId: 'browser', remoteHostId: null, deviceLinkDeviceId: null, workdir,
        patchState: patch => {
          const next = Object.assign({}, state, patch);
          save(next);
          setState(next);
        }, onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {} }}
      state={state}
    />;
  }
  return render(<Tab />);
}

// #11392, unit: a root watcher failure with a cached child made the visible
// retry button a no-op. Hook tests cannot exercise which action that button runs.
it('retries from the displayed subdirectory when the root read failed', async () => {
  const workdir = '/project';
  const onEvent = vi.fn((_listener: (event: { workdir: string; relPath: string }) => void) => () => {});
  let failRoot = false;
  const listDir = vi.fn(async ({ relPath }: { relPath: string }) => {
    if (!relPath && failRoot) throw new Error('offline');
    return relPath ? [] : [{ name: 'docs', relPath: 'docs', type: 'directory', size: 0, mtimeMs: 1 }];
  });
  vi.stubGlobal('electronAPI', {
    fileBrowser: { listDir, onEvent, startWatch: vi.fn(), stopWatch: vi.fn() },
    search: { onEvent: () => () => {} },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const view = mountBrowser(workdir, { selectedFilePath: null, revealDirPath: 'docs' });
  await waitFor(() => expect(listDir).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'docs' })));
  failRoot = true;
  act(() => {
    for (const [listener] of onEvent.mock.calls) listener({ workdir, relPath: 'changed.txt' });
  });
  const errorText = i18n.t('rightSidebar.fileBrowser.loadFailed');
  const error = await view.findByText(errorText);
  failRoot = false;
  listDir.mockClear();
  fireEvent.click(within(error.parentElement!).getByRole('button'));
  await waitFor(() => expect(listDir.mock.calls.map(([args]) => args.relPath).sort()).toEqual(['', 'docs']));
  expect(view.queryByText(errorText)).toBeNull();
  view.unmount();
});

// A task switch or detached-window handoff remounts this plugin with serialized tab state.
it('reopens the saved directory even when its tree was collapsed before handoff', async () => {
  const workdir = '/handoff';
  const listDir = vi.fn(async ({ relPath }: { relPath: string }) => {
    if (relPath === 'docs') return [{ name: 'draft', relPath: 'docs/draft', type: 'directory', size: 0, mtimeMs: 1 }];
    return relPath ? [] : [{ name: 'docs', relPath: 'docs', type: 'directory', size: 0, mtimeMs: 1 }];
  });
  vi.stubGlobal('electronAPI', {
    fileBrowser: { listDir, onEvent: () => () => {}, startWatch: vi.fn(), stopWatch: vi.fn() },
    search: { onEvent: () => () => {} },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const save = vi.fn();
  const view = mountBrowser(workdir, { selectedFilePath: null, revealDirPath: 'docs/draft' }, save);
  fireEvent.click(await view.findByRole('button', { name: 'docs' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ currentDirectory: 'docs' })));
  view.unmount();
  saveExpandedSet(workdir, new Set(), { showIgnoredDirs: false });
  listDir.mockClear();
  const hydrate = getTabKind('file-browser')!.hydrateState!;
  const saved = hydrate(JSON.parse(JSON.stringify(save.mock.lastCall![0]))) as FileBrowserState;
  const reopened = mountBrowser(workdir, saved);
  await waitFor(() => expect(listDir).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'docs' })));
  expect(reopened.queryByText(i18n.t('rightSidebar.fileBrowser.loadFailed'))).toBeNull();
  reopened.unmount();
});

// #11392, unit: an evicted preview or a new window restores the user's HTML
// view from serialized tab data. Older records can still open as source.
it('restores the selected HTML view after the preview must be recreated', async () => {
  vi.stubGlobal('electronAPI', {
    fileBrowser: {
      listDir: async () => [], onEvent: () => () => {}, startWatch: vi.fn(), stopWatch: vi.fn(),
      readFile: async () => ({ ok: true, data: { content: '<p>draft</p>', size: 12, mtimeMs: 1, truncated: false } }),
    },
    search: { onEvent: () => () => {} }, onRsbBrowserCommand: () => () => {},
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const save = vi.fn();
  const view = mountBrowser('/html-mode', { selectedFilePath: 'draft.html' }, save);
  fireEvent.click(await view.findByRole('button', { name: i18n.t('ccAgent.workdirBrowse.previewFile') }));
  await waitFor(() => expect(view.container.querySelector('webview')?.getAttribute('src')).toContain('draft.html'));
  view.unmount();
  const hydrate = getTabKind('file-browser')!.hydrateState!;
  const saved = hydrate(JSON.parse(JSON.stringify(save.mock.lastCall![0]))) as FileBrowserState;
  const reopened = mountBrowser('/html-mode', saved, save);
  await waitFor(() => expect(reopened.container.querySelector('webview')?.getAttribute('src')).toContain('draft.html'));
  fireEvent.click(reopened.getByRole('button', { name: i18n.t('chat.markdownRenderer.viewSourceFile') }));
  expect(reopened.container.querySelector('webview')).toBeNull();
  expect(hydrate(save.mock.lastCall![0])).not.toHaveProperty('previewHtmlPath');
  reopened.unmount();
});

// PR #11392, unit: a retained SSH preview must not keep the remote tree busy
// on file events or window focus. Exercise the mounted plugin and its transport.
it('pauses remote directory reads while the sidebar preview is hidden', async () => {
  const workdir = '/remote/notes';
  type Notice = { workdir: string; relPath: string; type: string };
  const listeners = new Set<(event: Notice) => void>();
  const listDir = vi.fn(async () => []);
  vi.stubGlobal('electronAPI', {
    fileBrowser: { listDir, startWatch: vi.fn(), stopWatch: vi.fn(),
      onEvent: (fn: (event: Notice) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      previewHtml: vi.fn().mockResolvedValue({ url: 'http://localhost/draft.html' }),
      cancelHtmlPreview: vi.fn().mockResolvedValue({ ok: true }),
    }, search: { onEvent: () => () => {} }, onRsbBrowserCommand: () => () => {},
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const ctx = { sessionId: 'ssh-notes', tabId: 'remote-preview', remoteHostId: 'ssh', deviceLinkDeviceId: null,
    workdir, patchState: vi.fn(), onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {} };
  const state = { selectedFilePath: 'draft.html', previewHtmlPath: 'draft.html' };
  const view = render(<FileBrowserBody ctx={ctx} state={state} active={false} />);
  expect(listDir).not.toHaveBeenCalled();
  view.rerender(<FileBrowserBody ctx={ctx} state={state} active />);
  await waitFor(() => expect(listDir).toHaveBeenCalledTimes(1));
  const guest = view.container.querySelector('webview');
  expect(guest).not.toBeNull();
  view.rerender(<FileBrowserBody ctx={ctx} state={state} active shellVisible={false} />);
  listDir.mockClear();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    for (const notify of listeners) notify({ workdir, relPath: 'new.txt', type: 'add' });
    await new Promise(resolve => setTimeout(resolve, 75));
  });
  expect(listDir).not.toHaveBeenCalled();
  view.rerender(<FileBrowserBody ctx={ctx} state={state} active />);
  await waitFor(() => expect(listDir).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector('webview')).toBe(guest);
  view.unmount();
});

// #11392, unit: retained tabs hide without unmounting. Exercise the actual video
// element, including a fetched copy, since HTML guest mute tests cannot cover it.
it.each([null, 'ssh'])('pauses the video on hide and keeps its position on return (remote=%s)', async remoteHostId => {
  const relPath = 'recording.mp4';
  let mtimeMs = 1;
  const readFile = vi.fn(async () => ({ ok: false, code: 'BINARY_FILE' }));
  const onEvent = vi.fn((_listener: (event: { workdir: string; relPath: string; type: string }) => void) => () => {});
  const fetchRemote = vi.fn(async () => ({ ok: true, cachePath: '/cache/video.mp4' }));
  vi.stubGlobal('electronAPI', {
    fileBrowser: { listDir: async () => [], startWatch: vi.fn(), stopWatch: vi.fn(), onEvent,
      readFile, stat: async () => ({ type: 'file', relPath, size: 1024, mtimeMs }),
      fetchRemote,
      onTransferProgress: () => () => {} },
    search: { onEvent: () => () => {} },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const ctx = { sessionId: 'video', tabId: 'file', remoteHostId, deviceLinkDeviceId: null, workdir: '/videos',
    patchState: vi.fn(), onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {} };
  const tab = (active: boolean, shellVisible: boolean) =>
    <FileBrowserBody ctx={ctx} state={{ selectedFilePath: relPath }} active={active} shellVisible={shellVisible} />;
  const view = render(tab(true, true));
  const video = await waitFor(() => {
    const player = view.container.querySelector('video');
    expect(player).not.toBeNull();
    return player!;
  });
  let paused = false;
  Object.defineProperty(video, 'paused', { get: () => paused });
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; });
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
  video.currentTime = 14;
  for (const hidden of [tab(false, true), tab(true, false)]) {
    paused = false;
    view.rerender(hidden);
    expect(video.paused).toBe(true);
    paused = false;
    fireEvent.play(video);
    expect(video.paused).toBe(true);
    await act(async () => { view.rerender(tab(true, true)); });
    expect(view.container.querySelector('video')).toBe(video);
    expect(video.currentTime).toBe(14);
    expect(play).not.toHaveBeenCalled();
  }
  view.rerender(tab(false, true));
  mtimeMs++;
  await act(async () => { view.rerender(tab(true, true)); });
  const replacement = view.container.querySelector('video')!;
  expect(replacement).not.toBe(video);
  expect(replacement.currentTime).toBe(0);
  // A visible player must also see a same-path replacement. Duplicate notices
  // with unchanged metadata leave its buffered position and cached copy intact.
  const notify = () => {
    for (const [listener] of onEvent.mock.calls) listener({ workdir: ctx.workdir, relPath, type: 'change' });
  };
  replacement.currentTime = 9;
  const previousSrc = replacement.src;
  fetchRemote.mockClear();
  await act(async () => { notify(); });
  expect(view.container.querySelector('video')).toBe(replacement);
  expect(replacement.currentTime).toBe(9);
  expect(fetchRemote).not.toHaveBeenCalled();
  mtimeMs++;
  await act(async () => { notify(); notify(); });
  const regenerated = view.container.querySelector('video')!;
  expect(regenerated).not.toBe(replacement);
  expect(regenerated.currentTime).toBe(0);
  expect(regenerated.src).not.toBe(previousSrc);
  expect(fetchRemote).toHaveBeenCalledTimes(remoteHostId ? 1 : 0);
  view.unmount();
});

// #11392, unit: a focused, still-visible SSH editor can miss a remote write.
// Drive the actual window event while its Markdown save and disk read overlap.
it.each(['A', 'B'])('preserves the draft through a failed focus recheck and reconciles remote content %s', async diskAfterFocus => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const relPath = 'note.md';
  const response = (content: string) => ({ ok: true, data: { relPath, content, size: content.length, mtimeMs: 1, truncated: false } });
  const pending = Promise.withResolvers<unknown>();
  const readFile = vi.fn().mockResolvedValueOnce(response('A')).mockReturnValueOnce(pending.promise)
    .mockResolvedValue(response(diskAfterFocus));
  const writeFile = vi.fn().mockResolvedValue({ ok: true, size: 7, mtimeMs: 2 });
  vi.stubGlobal('electronAPI', {
    fileBrowser: { listDir: async () => [], startWatch: vi.fn(), stopWatch: vi.fn(), onEvent: () => () => {},
      readFile, writeFile, cachePut: vi.fn() },
    search: { onEvent: () => () => {} }, onSelectionContextMenuAddToChat: () => () => {},
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const ctx = { sessionId: 'focus', tabId: 'files', remoteHostId: 'ssh', deviceLinkDeviceId: null,
    workdir: '/focus-' + diskAfterFocus, patchState: vi.fn(), onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {} };
  const view = render(<FileBrowserBody ctx={ctx} state={{ selectedFilePath: relPath }} active />);
  try {
    await act(async () => {});
    const node = view.container.querySelector<HTMLElement>('.cm-editor')!;
    const editor = EditorView.findFromDOM(node)!;
    act(() => { editor.dispatch({ changes: { from: 1, insert: ' draft' } }); });
    fireEvent.blur(window);
    fireEvent.focus(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(writeFile).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ ok: false, code: 'READ_FAILED' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(writeFile).not.toHaveBeenCalled();
    fireEvent.focus(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.container.querySelector('.cm-editor')).toBe(node);
    expect(editor.state.doc.toString()).toBe('A draft');
    if (diskAfterFocus === 'B') {
      expect(writeFile).not.toHaveBeenCalled();
      expect(view.getByRole('alert').textContent).toContain(i18n.t('ccAgent.workdirBrowse.fileBody.externalChangeBlocked'));
    } else {
      expect(writeFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ relPath, remoteHostId: 'ssh', content: 'A draft' }));
    }
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
