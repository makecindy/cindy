// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  getAbsPath: vi.fn(),
  context: {
    sessionId: undefined as string | undefined,
    workingDir: '/repo',
    origin: { kind: 'local' } as { kind: string; deviceId?: string; remoteHostId?: string },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({ useChatSessionFile: () => mocks.context }));
vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarTargetSessionId: (id: string | undefined) => id,
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(), pathToFileUrl: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(),
  openExternalFileInSidebarFileBrowser: vi.fn(),
  openFileInSidebarFileBrowser: vi.fn(),
}));
vi.mock('@/lib/remoteFileOpen', () => ({ copyRemoteChatFile: vi.fn(), revealRemoteChatFile: vi.fn() }));

import { useFileChipContextMenu } from '../components/chat/useFileChipContextMenu';
import type { FileLocation } from '../lib/fileLocation';

function FileReference({ location, directory = false }: { location?: FileLocation; directory?: boolean }) {
  const { onContextMenu, menu } = useFileChipContextMenu({
    getAbsPath: mocks.getAbsPath,
    sidebarFileBrowserKind: directory ? 'directory' : 'file',
    location,
  });
  return <><button onContextMenu={onContextMenu}>file reference</button>{menu}</>;
}

async function openMenu(location?: FileLocation, directory = false) {
  render(<FileReference location={location} directory={directory} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: 'file reference' }), { clientX: 10, clientY: 10 });
  await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyFilePath' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.workingDir = '/repo';
  mocks.context.origin = { kind: 'local' };
  mocks.getAbsPath.mockResolvedValue('/repo/src/example.ts');
  mocks.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: mocks.writeText },
  });
});
afterEach(cleanup);

describe('file chip Copy Location action', () => {
  it('copies relative path, line and column without resolving or opening the file again', async () => {
    await openMenu({ absPath: '/repo/src/example.ts', line: 42, column: 7 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('chat.markdownRenderer.locationCopied'));
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
  ] as const)('omits Copy Location for missing coordinates, outside files and directories (%j)', async (location, directory) => {
    await openMenu(location, directory);
    expect(screen.queryByRole('menuitem', { name: 'chat.markdownRenderer.copyLocation' })).toBeNull();
  });

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
