// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => (
    <span aria-hidden>{children}</span>
  ),
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  // 「打开方式」子菜单:测试只关心顶层菜单项路由,子菜单展开为直接渲染即可。
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
  pathToFileUrl: (path: string) => `file://${path}`,
}));

vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(async () => undefined),
  openExternalFileInSidebarFileBrowser: vi.fn(async () => true),
  openFileInSidebarFileBrowser: vi.fn(async () => true),
}));

vi.mock('@/lib/remoteFileOpen', () => ({
  copyRemoteChatFile: vi.fn(),
  downloadRemoteChatEntry: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SessionNavigationModeProvider } from '@/features/cc-agent/embeddedSessionNavigation';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import {
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { LOCAL_FILE_ORIGIN } from '@/lib/sessionFileOrigin';
import { setAttachmentPreviewPreference } from '@/hooks/useAttachmentPreviewPreference';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { UserAttachmentChip } from '../UserAttachmentChip';
import { useFileChipContextMenu } from '../useFileChipContextMenu';
import { useOpenWithMenu } from '../useOpenWithMenu';

function ActionProbe({ html = false }: { html?: boolean }) {
  const menu = useFileChipContextMenu({
    fileName: html ? 'index.html' : 'index.md',
    getAbsPath: () => (html ? '/repo/src/index.html' : '/repo/src/index.md'),
    canOpenInBrowser: html,
    sidebarOpenSessionId: 'worker-a',
  });
  return (
    <>
      <button type="button" onClick={(event) => menu.openAt(10, 20, event.currentTarget)}>
        open-menu
      </button>
      {menu.menu}
    </>
  );
}

function LinkActionProbe() {
  const menu = useOpenWithMenu({ sessionId: 'worker-a' });
  return (
    <>
      <button type="button" onClick={() => menu.openAt(10, 20, 'https://example.com/')}>
        open-link-menu
      </button>
      {menu.menu}
    </>
  );
}

function wrapper(children: ReactNode) {
  return (
    <SessionNavigationModeProvider mode="sidebar-embedded" sidebarTargetSessionId="lead-a">
      <ChatSessionFileProvider
        value={{
          sessionId: 'worker-a',
          workingDir: '/repo',
          origin: LOCAL_FILE_ORIGIN,
        }}
      >
        {children}
      </ChatSessionFileProvider>
    </SessionNavigationModeProvider>
  );
}

describe('sidebar-embedded action target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAttachmentPreviewPreference('popup');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        fileBrowser: {
          previewHtml: vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:12345/preview/' })),
        },
      },
    });
  });

  it('opens a task attachment in its own file panel after selecting the sidebar preference', async () => {
    setAttachmentPreviewPreference('sidebar');
    const openPopup = vi.fn();
    render(
      <ChatSessionFileProvider value={{ sessionId: 'task', workingDir: '/repo', origin: LOCAL_FILE_ORIGIN }}>
        <UserAttachmentChip file={{ name: 'notes.md', path: '/repo/notes.md' }} onOpenTextPreview={openPopup} />
      </ChatSessionFileProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));

    await waitFor(() => expect(openFileInSidebarFileBrowser).toHaveBeenCalledWith('task', 'notes.md'));
    expect(openPopup).not.toHaveBeenCalled();
  });

  it('keeps HTML in the visible Lead browser and avoids locating files in another task tree', async () => {
    const { rerender } = render(wrapper(<ActionProbe />));

    fireEvent.click(screen.getByText('open-menu'));
    expect(screen.queryByText('chat.markdownRenderer.openInSidebarFileBrowser')).toBeNull();

    rerender(wrapper(<ActionProbe html />));
    fireEvent.click(screen.getByText('open-menu'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarBrowser'));
    await waitFor(() =>
      expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('lead-a', 'file:///repo/src/index.html'),
    );
  });

  it('routes link menus to the same visible Lead browser bucket', async () => {
    render(wrapper(<LinkActionProbe />));

    fireEvent.click(screen.getByText('open-link-menu'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarBrowser'));

    await waitFor(() =>
      expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('lead-a', 'https://example.com/'),
    );
  });

  it('allows both one-off previews and project-tree location without changing the default', async () => {
    setAttachmentPreviewPreference('sidebar');
    const openPopup = vi.fn();
    render(
      <ChatSessionFileProvider value={{ sessionId: 'task', workingDir: '/repo', origin: LOCAL_FILE_ORIGIN }}>
        <UserAttachmentChip file={{ name: 'notes.md', path: '/repo/notes.md' }} onOpenTextPreview={openPopup} />
      </ChatSessionFileProvider>,
    );
    const chip = screen.getByRole('button', { name: 'notes.md' });

    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByText('chat.markdownRenderer.openFileInPopup'));
    await waitFor(() => expect(openPopup).toHaveBeenCalledWith(chip));
    expect(openFileInSidebarFileBrowser).not.toHaveBeenCalled();

    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarFileBrowser'));
    await waitFor(() => expect(openFileInSidebarFileBrowser).toHaveBeenCalledWith('task', 'notes.md', 'locate-file'));

    setAttachmentPreviewPreference('popup');
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByText('chat.markdownRenderer.openFileInSidebar'));
    await waitFor(() => expect(openFileInSidebarFileBrowser).toHaveBeenLastCalledWith('task', 'notes.md'));
    fireEvent.click(chip);
    await waitFor(() => expect(openPopup).toHaveBeenCalledTimes(2));
  });

  it('offers sidebar preview for a local external file without a project-tree action', async () => {
    render(
      <ChatSessionFileProvider value={{ sessionId: 'task', workingDir: '/repo', origin: LOCAL_FILE_ORIGIN, localConfirmed: true }}>
        <UserAttachmentChip file={{ name: 'outside.md', path: '/tmp/outside.md' }} onOpenTextPreview={vi.fn()} />
      </ChatSessionFileProvider>,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'outside.md' }));
    expect(screen.queryByText('chat.markdownRenderer.openInSidebarFileBrowser')).toBeNull();
    fireEvent.click(screen.getByText('chat.markdownRenderer.openFileInSidebar'));
    await waitFor(() =>
      expect(openExternalFileInSidebarFileBrowser).toHaveBeenCalledWith('task', '/tmp/outside.md'),
    );
    expect(openFileInSidebarFileBrowser).not.toHaveBeenCalled();
  });
});
