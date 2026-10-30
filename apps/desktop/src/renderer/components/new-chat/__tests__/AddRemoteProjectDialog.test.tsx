// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowseListResult } from '../remoteBrowseAdapters';

const mocks = vi.hoisted(() => ({
  devices: [] as Array<{ deviceId: string; name: string }>,
  sessions: [],
  t: (key: string) => key,
  listDir: vi.fn(async (): Promise<BrowseListResult> => ({ resolvedPath: '~', parent: null, entries: [] })),
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
  mocks.devices = [];
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

it('locks the move folder picker to the task host and never falls back to another computer', async () => {
  mocks.devices = [{ deviceId: 'A', name: 'Source Mac' }, { deviceId: 'B', name: 'Other Mac' }];
  vi.stubGlobal('electronAPI', {
    remoteSsh: { list: async () => ({ hosts: [] }) },
    deviceLink: { invoke: async () => [] },
  });
  const props = { open: true, onOpenChange: vi.fn(), onProjectAdded: vi.fn(), initialDeviceId: 'A', fixedDeviceId: 'A', title: 'Move task', confirmText: 'Move' };
  const view = render(<AddRemoteProjectDialog {...props} />);
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('device:A'));
  expect(screen.queryByRole('option', { name: 'Other Mac' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Move task' })).toBeTruthy();
  mocks.devices = [{ deviceId: 'B', name: 'Other Mac' }];
  view.rerender(<AddRemoteProjectDialog {...props} />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.queryByRole('option', { name: 'Other Mac' })).toBeNull();
  expect(props.onProjectAdded).not.toHaveBeenCalled();
});

it('selects a folder on the pinned Worker device by drive and directory navigation', async () => {
  mocks.devices = [{ deviceId: 'B', name: 'Worker PC' }];
  vi.stubGlobal('electronAPI', { remoteSsh: { list: async () => ({ hosts: [] }) }, deviceLink: { invoke: async () => [] } });
  const onProjectAdded = vi.fn();
  mocks.listDir.mockResolvedValueOnce({ resolvedPath: 'C:\\Users\\test', parent: 'C:\\Users', entries: [],
    drives: [{ name: 'C:', path: 'C:\\', current: true }, { name: 'D:', path: 'D:\\', current: false }] });
  mocks.listDir.mockResolvedValueOnce({ resolvedPath: 'D:\\', parent: null,
    entries: [{ name: 'projects', childPath: 'D:\\projects', kind: 'dir' }] });
  mocks.statPath.mockResolvedValueOnce({ kind: 'dir', resolvedPath: 'D:\\projects' });
  render(<AddRemoteProjectDialog open initialDeviceId="B" fixedDeviceId="B" onOpenChange={vi.fn()} onProjectAdded={onProjectAdded} />);
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('device:B'));
  fireEvent.click(screen.getByRole('radio', { name: 'newChat.addRemoteProject.tabBrowse' }));
  fireEvent.click(await screen.findByRole('button', { name: 'D:' }));
  fireEvent.click(await screen.findByRole('button', { name: 'projects' }));
  fireEvent.click(screen.getByRole('button', { name: 'newChat.addRemoteProject.add' }));
  await waitFor(() => expect(onProjectAdded).toHaveBeenCalledWith({ kind: 'device-link', deviceId: 'B', deviceName: 'Worker PC', path: 'D:\\projects' }));
  expect(mocks.listDir).toHaveBeenCalledWith('D:\\');
  expect(mocks.mkdirP).not.toHaveBeenCalled();
});

it('does not select or close a new presentation after a dismissed stat request finishes', async () => {
  mocks.devices = [{ deviceId: 'B', name: 'Worker PC' }];
  vi.stubGlobal('electronAPI', { remoteSsh: { list: async () => ({ hosts: [] }) }, deviceLink: { invoke: async () => [] } });
  let finish!: (value: { kind: string; resolvedPath: string }) => void;
  mocks.statPath.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const props = { initialDeviceId: 'B', fixedDeviceId: 'B', onOpenChange: vi.fn(), onProjectAdded: vi.fn() };
  const view = render(<AddRemoteProjectDialog open {...props} />);
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('device:B'));
  fireEvent.click(screen.getByRole('radio', { name: 'newChat.addRemoteProject.tabBrowse' }));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'newChat.addRemoteProject.add' }));
  view.rerender(<AddRemoteProjectDialog open={false} {...props} />);
  view.rerender(<AddRemoteProjectDialog open {...props} />);
  await act(async () => finish({ kind: 'dir', resolvedPath: 'D:\\old' }));
  expect(props.onProjectAdded).not.toHaveBeenCalled();
  expect(props.onOpenChange).not.toHaveBeenCalled();
});
