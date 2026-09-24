// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { GeneratedFilesCard } from '../GeneratedFilesCard';
import { _clearRemotePathVerdictCache } from '@/lib/remoteFileOpen';

vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({ menu: null, onContextMenu: vi.fn() }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  _clearRemotePathVerdictCache();
  vi.unstubAllGlobals();
});

describe('remote generated files', () => {
  it('shows a command artifact after remote verification and never stats the controller filesystem', async () => {
    const chatStat = vi.fn().mockResolvedValue({ verdict: 'file' });
    const statPath = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        fileBrowser: { chatStat },
        fsBrowse: { statPath },
      },
    });
    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 'remote-task',
          workingDir: '/remote',
          origin: { kind: 'device', deviceId: 'host' },
        }}
      >
        <GeneratedFilesCard
          files={[
            { path: '/remote/report.zip', name: 'report.zip', source: 'command', ready: true },
          ]}
          turnStartMs={200_000}
          turnEndMs={300_000}
          turnSealed
        />
      </ChatSessionFileProvider>,
    );
    await waitFor(() => expect(screen.getByText('report.zip')).toBeTruthy());
    expect(chatStat).toHaveBeenCalledWith({
      origin: { kind: 'device', deviceId: 'host' },
      workdir: '/remote',
      absPath: '/remote/report.zip',
      modifiedWindow: { startMs: 80_000, endMs: 300_000 },
    });
    expect(statPath).not.toHaveBeenCalled();
  });
  it('keeps SSH tool artifacts without applying the Desktop clock to SSH command artifacts', async () => {
    const chatStat = vi.fn().mockResolvedValue({ verdict: 'file' });
    const statPath = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { fileBrowser: { chatStat }, fsBrowse: { statPath } },
    });
    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 'ssh-task',
          workingDir: '/remote',
          origin: { kind: 'ssh', remoteHostId: 'host' },
        }}
      >
        <GeneratedFilesCard
          files={[
            { path: '/remote/report.zip', name: 'report.zip', source: 'command', ready: true },
            { path: '/remote/notes.txt', name: 'notes.txt', source: 'tool', ready: true },
          ]}
          turnStartMs={200_000}
          turnEndMs={300_000}
          turnSealed
        />
      </ChatSessionFileProvider>,
    );
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy());
    expect(screen.queryByText('report.zip')).toBeNull();
    expect(chatStat).toHaveBeenCalledTimes(1);
    expect(chatStat).toHaveBeenCalledWith({
      origin: { kind: 'ssh', remoteHostId: 'host' },
      workdir: '/remote',
      absPath: '/remote/notes.txt',
    });
    expect(statPath).not.toHaveBeenCalled();
  });
});
