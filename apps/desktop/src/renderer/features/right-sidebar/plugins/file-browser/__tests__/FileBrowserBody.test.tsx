// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { FileBrowserBody } from '../FileBrowserBody';

vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({ FileBodyView: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useConfirmSwitchAwayIfDirty', () => ({
  useConfirmSwitchAwayIfDirty: () => async () => true,
}));
afterEach(() => vi.unstubAllGlobals());

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
  const view = render(<FileBrowserBody
    ctx={{ sessionId: '', tabId: 'browser', remoteHostId: null, workdir,
      patchState: vi.fn(), onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {} }}
    state={{ selectedFilePath: null, revealDirPath: 'docs' }}
  />);
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
