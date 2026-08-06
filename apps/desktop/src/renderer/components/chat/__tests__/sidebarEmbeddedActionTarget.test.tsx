// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
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
  openExternalFileInSidebarFileBrowser: vi.fn(async () => undefined),
  openFileInSidebarFileBrowser: vi.fn(async () => undefined),
}));

vi.mock('@/lib/remoteFileOpen', () => ({
  copyRemoteChatFile: vi.fn(),
  revealRemoteChatFile: vi.fn(),
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
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { useFileChipContextMenu } from '../useFileChipContextMenu';
import { useOpenWithMenu } from '../useOpenWithMenu';

function ActionProbe() {
  const menu = useFileChipContextMenu({
    getAbsPath: () => '/repo/src/App.tsx',
    sidebarOpenSessionId: 'worker-a',
  });
  return (
    <>
      <button type="button" onClick={() => menu.openAt(10, 20)}>
        open-menu
      </button>
      {menu.menu}
    </>
  );
}

function ExternalFileActionProbe() {
  const menu = useFileChipContextMenu({
    getAbsPath: () => 'C:\\tmp\\outside.md',
  });
  return (
    <>
      <button type="button" onClick={() => menu.openAt(10, 20)}>
        open-external-menu
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
    <SessionNavigationModeProvider
      mode="sidebar-embedded"
      sidebarTargetSessionId="lead-a"
    >
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
  beforeEach(() => vi.clearAllMocks());

  it('opens file-browser and web-browser tabs in the visible Lead bucket', async () => {
    render(wrapper(<ActionProbe />));

    fireEvent.click(screen.getByText('open-menu'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarFileBrowser'));
    await waitFor(() =>
      expect(openFileInSidebarFileBrowser).toHaveBeenCalledWith('lead-a', 'src/App.tsx'),
    );

    fireEvent.click(screen.getByText('open-menu'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarBrowser'));
    await waitFor(() =>
      expect(openUrlInSidebarBrowser).toHaveBeenCalledWith(
        'lead-a',
        'file:///repo/src/App.tsx',
      ),
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

  it('opens a local file outside the workdir through the external-file preview path', async () => {
    render(wrapper(<ExternalFileActionProbe />));

    fireEvent.click(screen.getByText('open-external-menu'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.openInSidebarFileBrowser'));

    await waitFor(() =>
      expect(openExternalFileInSidebarFileBrowser).toHaveBeenCalledWith(
        'lead-a',
        'C:\\tmp\\outside.md',
      ),
    );
    expect(openFileInSidebarFileBrowser).not.toHaveBeenCalled();
  });
});
