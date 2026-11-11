// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  getAbsPath: vi.fn(),
  openPath: vi.fn(async () => ({ success: true })),
  openFileInBrowser: vi.fn(async () => undefined),
  openDefault: vi.fn(),
  openRemoteChatFile: vi.fn(),
  reveal: vi.fn(async () => ({ success: true })),
  download: vi.fn(async () => undefined),
  saveAttachment: vi.fn(async () => undefined),
  context: {
    sessionId: undefined as string | undefined,
    workingDir: '/repo',
    origin: { kind: 'local' } as { kind: string; deviceId?: string; remoteHostId?: string },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/lib/chatAttachmentSave', () => ({
  isSafetyDowngradedAttachment: () => true,
  saveChatAttachmentWithToasts: mocks.saveAttachment,
}));
vi.mock('@/lib/filePreview', () => ({ shouldOpenTextLightboxForOrigin: vi.fn() }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({
  useChatSessionFile: () => mocks.context,
}));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarTargetSessionId: (id: string | undefined) => id,
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(),
  pathToFileUrl: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(),
  openExternalFileInSidebarFileBrowser: vi.fn(),
  openFileInSidebarFileBrowser: vi.fn(),
}));
vi.mock('@/lib/remoteFileOpen', () => ({
  copyRemoteChatFile: vi.fn(),
  downloadRemoteChatEntry: mocks.download,
  openRemoteChatFile: mocks.openRemoteChatFile,
}));
vi.mock('../components/chat/TextLightbox', () => ({
  TextLightbox: ({ filePath }: { filePath: string }) => (
    <div data-testid="source-preview">{filePath}</div>
  ),
}));

import { useFileChipContextMenu } from '../components/chat/useFileChipContextMenu';
import { UserAttachmentChip } from '../components/chat/UserAttachmentChip';
import type { FileLocation } from '../lib/fileLocation';

function FileReference({
  location,
  directory = false,
  html = false,
  fileName = 'example.ts',
}: {
  location?: FileLocation;
  directory?: boolean;
  html?: boolean;
  fileName?: string;
}) {
  const { onContextMenu, onActivate, openAt, menu } = useFileChipContextMenu({
    fileName,
    getAbsPath: mocks.getAbsPath,
    sidebarFileBrowserKind: directory ? 'directory' : 'file',
    location,
    canOpenInBrowser: html,
  });
  return (
    <>
      <button
        onClick={(event) => onActivate(event, mocks.openDefault)}
        onContextMenu={onContextMenu}
      >
        file reference
      </button>
      <button
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            openAt(10, 20, event.currentTarget);
          }
        }}
      >
        tool row
      </button>
      {menu}
    </>
  );
}

async function openMenu(location?: FileLocation, directory = false) {
  render(<FileReference location={location} directory={directory} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: 'file reference' }), {
    clientX: 10,
    clientY: 10,
  });
  await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyFilePath' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.workingDir = '/repo';
  mocks.context.sessionId = undefined;
  mocks.context.origin = { kind: 'local' };
  mocks.getAbsPath.mockResolvedValue('/repo/src/example.ts');
  mocks.writeText.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openPath: mocks.openPath,
      openFileInBrowser: mocks.openFileInBrowser,
      showItemInFolder: mocks.reveal,
    },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});
afterEach(cleanup);

describe('file chip Copy Location action', () => {
  it.each([
    { kind: 'device', deviceId: 'remote-computer' },
    { kind: 'ssh', remoteHostId: 'ssh-host' },
  ])('hides default-app opening for remote scripts (%j)', async (origin) => {
    mocks.context.origin = origin;
    render(<FileReference fileName="script.PS1" />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'file reference' }));
    const download = await screen.findByRole('menuitem', { name: 'chat.remoteFile.downloadToLocal' });
    expect(screen.queryByRole('menuitem', { name: /chat.media.openWithApp/ })).toBeNull();
    fireEvent.click(download);
    await waitFor(() => expect(mocks.download).toHaveBeenCalled());
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each(['ContextMenu', 'F10'])('restores focus to the latest keyboard trigger (%s)', async (key) => {
    render(<FileReference />);
    const file = screen.getByRole('button', { name: 'file reference' });
    const row = screen.getByRole('button', { name: 'tool row' });
    file.focus();
    fireEvent.contextMenu(file);
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(file));
    row.focus();
    fireEvent.keyDown(row, { key, shiftKey: key === 'F10' });
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it.each(['escape', 'save'])('restores attachment focus when the save-only menu closes via %s', async (action) => {
    render(<UserAttachmentChip file={{ name: 'installer.exe', path: '/repo/attachment.bin' }} onOpenTextPreview={vi.fn()} />);
    const attachment = screen.getByRole('button');
    attachment.focus();
    fireEvent.keyDown(attachment, { key: 'F10', shiftKey: true });
    const item = await screen.findByRole('menuitem', { name: 'chat.media.saveAs' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    if (action === 'escape') fireEvent.keyDown(item, { key: 'Escape' });
    else fireEvent.click(item);
    await waitFor(() => expect(document.activeElement).toBe(attachment));
    expect(mocks.saveAttachment).toHaveBeenCalledTimes(action === 'save' ? 1 : 0);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each(['local', 'device'] as const)(
    'keeps the HTML menu flat and replaces reveal with download for %s files',
    async (kind) => {
      mocks.context.sessionId = 'task';
      mocks.context.origin = kind === 'local' ? { kind } : { kind, deviceId: 'remote-device' };
      mocks.getAbsPath.mockResolvedValue('/repo/page.html');
      render(<FileReference html />);
      fireEvent.contextMenu(screen.getByRole('button', { name: 'file reference' }));
      const items = await screen.findAllByRole('menuitem');
      expect(
        items.map((item) => item.textContent?.replace('chat.markdownRenderer.shiftClick', '')),
      ).toEqual([
        'chat.markdownRenderer.openInSidebarBrowser',
        'chat.markdownRenderer.openInDefaultBrowser',
        'chat.markdownRenderer.viewSourceFile',
        kind === 'local' ? 'chat.markdownRenderer.revealFile' : 'chat.remoteFile.downloadToLocal',
        'chat.markdownRenderer.copyFilePath',
      ]);
      expect(items.every((item) => !item.hasAttribute('aria-haspopup'))).toBe(true);
      fireEvent.click(items[3]);
      if (kind === 'local') {
        await waitFor(() =>
          expect(mocks.reveal).toHaveBeenCalledWith({ filePath: '/repo/page.html' }),
        );
        expect(mocks.download).not.toHaveBeenCalled();
      } else {
        await waitFor(() =>
          expect(mocks.download).toHaveBeenCalledWith(
            { kind: 'device', deviceId: 'remote-device' },
            '/repo',
            '/repo/page.html',
          ),
        );
        expect(mocks.reveal).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps source viewing available for HTML callers without a custom preview callback', async () => {
    mocks.getAbsPath.mockResolvedValue('/repo/page.html');
    render(<FileReference html />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'file reference' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.viewSourceFile' }),
    );
    expect((await screen.findByTestId('source-preview')).textContent).toBe('/repo/page.html');
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('offers the default application directly for ordinary files', async () => {
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.media.openWithApp' }));
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/repo/src/example.ts'));
  });

  it('keeps normal clicks in the preview and sends modifier clicks to the default application', async () => {
    render(<FileReference />);
    const link = screen.getByRole('button', { name: 'file reference' });
    fireEvent.click(link);
    expect(mocks.openDefault).toHaveBeenCalledOnce();
    expect(mocks.openPath).not.toHaveBeenCalled();
    fireEvent.click(link, { shiftKey: true });
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/repo/src/example.ts'));
    expect(mocks.openDefault).toHaveBeenCalledOnce();
  });

  it('opens modified HTML links in the system browser, not the file default application', async () => {
    mocks.getAbsPath.mockResolvedValue('/repo/page.html');
    render(<FileReference html />);
    fireEvent.click(screen.getByRole('button', { name: 'file reference' }), { metaKey: true });
    await waitFor(() => expect(mocks.openFileInBrowser).toHaveBeenCalledWith('/repo/page.html'));
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openDefault).not.toHaveBeenCalled();
  });

  it('opens remote files through the source-aware transfer, never the local path', async () => {
    mocks.context.origin = { kind: 'device', deviceId: 'remote-device' };
    render(<FileReference />);
    fireEvent.click(screen.getByRole('button', { name: 'file reference' }), { ctrlKey: true });
    await waitFor(() =>
      expect(mocks.openRemoteChatFile).toHaveBeenCalledWith(
        { kind: 'device', deviceId: 'remote-device' },
        '/repo',
        '/repo/src/example.ts',
      ),
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reports path resolution failures rather than leaking rejected promises', async () => {
    mocks.getAbsPath.mockRejectedValueOnce(new Error('missing'));
    render(<FileReference />);
    fireEvent.click(screen.getByRole('button', { name: 'file reference' }), { shiftKey: true });
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('chat.markdownRenderer.openWithAppFailed'),
    );
    expect(mocks.openDefault).not.toHaveBeenCalled();
  });
  it('copies relative path, line and column without resolving or opening the file again', async () => {
    await openMenu({ absPath: '/repo/src/example.ts', line: 42, column: 7 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith('chat.markdownRenderer.locationCopied'),
    );
    expect(mocks.writeText).toHaveBeenCalledWith('src/example.ts:42:7');
    expect(mocks.getAbsPath).not.toHaveBeenCalled();
  });

  it('retains the separate absolute-path copy action', async () => {
    await openMenu({ absPath: '/repo/src/example.ts', line: 42 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.markdownRenderer.copyFilePath' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('/repo/src/example.ts'));
    expect(mocks.success).toHaveBeenCalledWith('chat.markdownRenderer.pathCopied');
  });

  it.each([
    [undefined, false],
    [{ absPath: '/repo/src/example.ts' }, false],
    [{ absPath: '/outside/example.ts', line: 42 }, false],
    [{ absPath: '/repo/src', line: 42 }, true],
  ] as const)(
    'omits Copy Location for missing coordinates, outside files and directories (%j)',
    async (location, directory) => {
      await openMenu(location, directory);
      expect(
        screen.queryByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' }),
      ).toBeNull();
    },
  );

  it('uses the remote source workdir, not the local clipboard host', async () => {
    mocks.context.workingDir = 'D:\\Remote';
    mocks.context.origin = { kind: 'device', deviceId: 'remote-device' };
    await openMenu({ absPath: 'd:\\remote\\src\\example.ts', line: 42 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('src/example.ts:42'));
    expect(mocks.getAbsPath).not.toHaveBeenCalled();
  });

  it('reports clipboard failure without reporting success', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    await openMenu({ absPath: '/repo/src/example.ts', line: 42 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('chat.media.copyFailed'));
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
