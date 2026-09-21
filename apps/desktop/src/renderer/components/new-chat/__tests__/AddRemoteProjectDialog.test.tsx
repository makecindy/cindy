// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  devices: [],
  sessions: [],
  t: (key: string) => key,
  listDir: vi.fn(async () => ({ parent: null, entries: [] })),
  statPath: vi.fn(),
  mkdirP: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/hooks/useControllableDevices', () => ({ useControllableDevices: () => mocks.devices }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: mocks.sessions }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('../remoteBrowseAdapters', () => ({
  sshBrowseAdapter: () => mocks,
  deviceLinkBrowseAdapter: () => mocks,
}));
import { AddRemoteProjectDialog } from '../AddRemoteProjectDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('remote project mode selection', () => {
  it('browses lazily, clears the old path on return, and locks both modes while adding', async () => {
    vi.stubGlobal('electronAPI', {
      remoteSsh: {
        list: async () => ({
          hosts: [
            { status: 'ready', config: { id: 'audit', user: 'test', hostname: 'example.test' } },
          ],
        }),
      },
    });
    // The production code reads window.electronAPI; this stub never connects to a remote.
    const onProjectAdded = vi.fn();
    render(<AddRemoteProjectDialog open onOpenChange={vi.fn()} onProjectAdded={onProjectAdded} />);
    const existing = await screen.findByRole('radio', {
      name: 'newChat.addRemoteProject.tabExisting',
    });
    const browse = screen.getByRole('radio', { name: 'newChat.addRemoteProject.tabBrowse' });
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ssh:audit'),
    );
    await act(async () => {});
    expect(mocks.listDir).not.toHaveBeenCalled();
    fireEvent.click(browse);
    await waitFor(() => expect(mocks.listDir).toHaveBeenCalledWith('~'));
    fireEvent.change(screen.getByPlaceholderText('~/projects/my-repo'), {
      target: { value: '/old-path' },
    });
    fireEvent.keyDown(browse, { key: 'Home' });
    expect(existing.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByPlaceholderText('~/projects/my-repo')).toBeNull();
    fireEvent.keyDown(existing, { key: 'End' });
    expect((screen.getByPlaceholderText('~/projects/my-repo') as HTMLInputElement).value).toBe('~');
    let finish!: (value: { kind: string; resolvedPath: string }) => void;
    mocks.statPath.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'newChat.addRemoteProject.add' }));
    expect(existing.hasAttribute('disabled')).toBe(true);
    expect(browse.hasAttribute('disabled')).toBe(true);
    fireEvent.click(existing);
    expect(browse.getAttribute('aria-checked')).toBe('true');
    await act(async () => finish({ kind: 'directory', resolvedPath: '/home/test' }));
    expect(onProjectAdded).toHaveBeenCalledWith({
      kind: 'ssh',
      hostId: 'audit',
      path: '/home/test',
    });
  });
});
