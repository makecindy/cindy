// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileBrowserBody } from '../FileBrowserBody';
import { subscribeFileMentionInsert } from '@/lib/composerActionsBus';
import type { TabKindHostContext } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/features/cc-agent/workdir-browse/FileBodyView', () => ({ FileBodyView: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/search/SearchPanel', () => ({ SearchPanel: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useFileTree', () => ({
  useFileTree: () => ({
    entries: new Map([['', [{ name: 'README.md', relPath: 'README.md', type: 'file', size: 10, mtimeMs: 1 }]]]),
    expanded: new Set(['']), loadingPaths: new Set(), initialLoading: false, loadError: null,
    toggleFolder: vi.fn(), collapseAll: vi.fn(), refresh: vi.fn(), expandToPath: vi.fn(),
  }),
}));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useFileContent', () => ({ useFileContent: () => ({ content: null }) }));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useConfirmSwitchAwayIfDirty', () => ({ useConfirmSwitchAwayIfDirty: () => vi.fn().mockResolvedValue(true) }));
vi.mock('@/features/cc-agent/workdir-browse/hooks/useProjectFileList', () => ({ useProjectFileList: () => ({ files: [], refresh: vi.fn() }) }));
vi.mock('@/features/cc-agent/workdir-browse/search/hooks/useProjectSearch', () => ({ useProjectSearch: () => ({ results: [], status: 'idle' }) }));
vi.mock('../useSessionScopedTreeWidth', () => ({
  TREE_MIN_WIDTH: 120, TREE_MAX_WIDTH: 500,
  useSessionScopedTreeWidth: () => ({ width: 200, handleDragStart: vi.fn(), resetWidth: vi.fn(), isDragging: false }),
}));

const ctx: TabKindHostContext = {
  tabId: 'files', sessionId: 'session-a', workdir: '/workspace', remoteHostId: null,
  patchState: vi.fn(), onVisibilityChange: vi.fn(), setCloseInterceptor: () => () => {},
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

it.each([
  ['main', '/', true],
  ['secondary', '/?secondaryWindow=1', true],
  ['detached sidebar', '/?sidebarWindow=1#/sidebar-window', false],
] as const)('only offers add-to-chat in composer hosts: %s', async (_host, url, supported) => {
  window.history.replaceState({}, '', url);
  const handler = vi.fn().mockReturnValue(true);
  const unsubscribe = subscribeFileMentionInsert(ctx.sessionId, handler);
  try {
    const { container } = render(<FileBrowserBody state={{ selectedFilePath: null }} ctx={ctx} />);
    fireEvent.contextMenu(container.querySelector('[data-relpath="README.md"]')!);
    await screen.findByRole('menu');
    const item = screen.queryByRole('menuitem', { name: 'chat.quote.addToChat' });
    if (supported) {
      expect(item).not.toBeNull();
      fireEvent.click(item!);
      expect(handler).toHaveBeenCalledExactlyOnceWith({ targetSessionId: ctx.sessionId, type: 'file', relPath: 'README.md', name: 'README.md' });
    } else {
      expect(item).toBeNull();
      expect(handler).not.toHaveBeenCalled();
    }
  } finally {
    unsubscribe();
  }
});
