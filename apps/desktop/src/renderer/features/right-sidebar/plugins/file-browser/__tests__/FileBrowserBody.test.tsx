// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { FileBrowserBody } from '../FileBrowserBody';
import type { FileBrowserState } from '../index';
import '../index';
import { getTabKind } from '../../../registry';
import { saveExpandedSet } from '@/features/cc-agent/workdir-browse/lib/expandedStore';

vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({ FileBodyView: () => null }));
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
