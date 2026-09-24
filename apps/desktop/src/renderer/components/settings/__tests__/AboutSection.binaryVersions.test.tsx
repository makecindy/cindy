// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    // Append the product name so each harness row's actions stay distinguishable.
    t: (key: string, values?: { name?: string }) => (values?.name ? `${key} ${values.name}` : key),
  }),
}));

import { AgentVersionsRows } from '../AboutSection';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

const getBinaryVersion = vi.fn();
const getState = vi.fn();
const relaunchForHarnessUpdate = vi.fn();
const anyActivityBlockingRelaunch = vi.fn();

type Online = { latestVersion: string; updateAvailable: boolean } | 'failed' | null;

function versionResult(kind: string, options: { checkLatest?: boolean } | undefined, online: Online) {
  const local = { kind, binaryPath: `/${kind}`, version: '1.0.0', latestCheckFailed: false };
  if (!options?.checkLatest || !online) return { ...local, latestVersion: null, updateAvailable: false };
  if (online === 'failed') return { ...local, latestVersion: null, updateAvailable: false, latestCheckFailed: true };
  return { ...local, ...online };
}

const CODEX_UPDATE = { latestVersion: '1.1.0', updateAvailable: true };

function mockOnline(byKind: Partial<Record<'claude-code' | 'codex', Online>>) {
  getBinaryVersion.mockImplementation((kind: 'claude-code' | 'codex', options?: { checkLatest?: boolean }) =>
    Promise.resolve(versionResult(kind, options, byKind[kind] ?? null)),
  );
}

async function openMenu(name: 'Claude Code' | 'Codex') {
  await waitFor(() => expect(screen.queryByText('settings.about.harnessChecking')).toBeNull());
  fireEvent.keyDown(screen.getByRole('button', { name: `settings.about.harnessManage ${name}` }), { key: 'ArrowDown' });
  await screen.findByRole('menu');
}

describe('AboutSection agent binary versions', () => {
  const renderRows = () =>
    render(
      <ConfirmDialogProvider>
        <AgentVersionsRows />
      </ConfirmDialogProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockResolvedValue({ currentVersion: '0.84.4', restartRequired: false, official: { release: null }, upstream: { release: null }, operation: null });
    anyActivityBlockingRelaunch.mockResolvedValue(false);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      relaunchForHarnessUpdate,
      anyActivityBlockingRelaunch,
      maker: {
        piKernel: { getState },
        agent: {
          getBinaryVersion,
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('requests and renders Claude Code, Codex, and Pi versions', async () => {
    getBinaryVersion.mockImplementation((kind: string) =>
      Promise.resolve({
        kind,
        binaryPath: `/${kind}`,
        version: kind === 'claude-code' ? '2.1.258 (Claude Code)' : 'codex-cli 0.145.0',
        latestVersion: null,
        updateAvailable: false,
        latestCheckFailed: false,
      }),
    );

    renderRows();

    await waitFor(() => expect(getBinaryVersion).toHaveBeenCalledTimes(4));
    expect(getBinaryVersion).toHaveBeenCalledWith('claude-code');
    expect(getBinaryVersion).toHaveBeenCalledWith('codex');
    expect(getBinaryVersion).toHaveBeenCalledWith('claude-code', { checkLatest: true });
    expect(getBinaryVersion).toHaveBeenCalledWith('codex', { checkLatest: true });
    expect(getState).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('settings.about.claudeCodeVersionLabel')).toBeTruthy();
      expect(screen.getByText('settings.about.codexVersionLabel')).toBeTruthy();
      expect(screen.getByText('settings.about.piVersionLabel')).toBeTruthy();
      expect(screen.getByText('2.1.258')).toBeTruthy();
      expect(screen.getByText('0.145.0')).toBeTruthy();
      expect(screen.getByText('0.84.4')).toBeTruthy();
    });
  });

  it('shows the existing not-ready state when Pi is unavailable', async () => {
    getState.mockResolvedValue({ currentVersion: null, restartRequired: false, official: { release: null }, upstream: { release: null }, operation: null });
    mockOnline({});

    renderRows();

    await waitFor(() => expect(screen.getByText('settings.about.version.notReady')).toBeTruthy());
  });

  it('shows the local version while the online comparison is still checking', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      options?.checkLatest ? new Promise(() => {}) : Promise.resolve(versionResult(kind, options, null)),
    );

    renderRows();

    await waitFor(() => expect(screen.getAllByText('1.0.0')).toHaveLength(2));
    expect(screen.queryByText('settings.about.version.loading')).toBeNull();
    expect(screen.getAllByText('settings.about.harnessChecking')).toHaveLength(2);
  });

  it('keeps Pi-style collapsed rows and marks only the harness Main reports as newer', async () => {
    // A local build newer than the channel manifest differs but is not an update.
    mockOnline({ 'claude-code': { latestVersion: '0.9.0', updateAvailable: false }, codex: CODEX_UPDATE });

    renderRows();

    await screen.findByText('settings.about.harnessUpdateAvailable');
    expect(screen.getAllByText('settings.about.harnessUpdateAvailable')).toHaveLength(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('1.1.0')).toBeNull();

    await openMenu('Codex');
    const codexUpdate = screen.getByRole('menuitem', { name: /harnessUpdateButton Codex.*1\.1\.0/ });
    expect(codexUpdate.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByText('settings.about.harnessCheckedAt')).toBeTruthy();
  });

  it('disables the update action when the channel has no newer version', async () => {
    mockOnline({ 'claude-code': { latestVersion: '0.9.0', updateAvailable: false } });

    renderRows();
    await openMenu('Claude Code');

    const update = screen.getByRole('menuitem', { name: /harnessUpdateButton Claude Code.*0\.9\.0/ });
    expect(update.getAttribute('aria-disabled')).toBe('true');
  });

  it('reports a failed online check inline and keeps the local version', async () => {
    mockOnline({ codex: 'failed' });

    renderRows();

    await screen.findByText('settings.about.harnessCheckFailed');
    expect(screen.getAllByText('settings.about.harnessCheckFailed')).toHaveLength(1);
    expect(screen.getAllByText('1.0.0')).toHaveLength(2);

    await openMenu('Codex');
    expect(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex.*—/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('settings.about.harnessCheckedAt')).toBeNull();
  });

  it('checks again from the menu, keeps the last version, and disables update when that check fails', async () => {
    mockOnline({ codex: CODEX_UPDATE });

    renderRows();
    await screen.findByText('settings.about.harnessUpdateAvailable');

    mockOnline({ codex: 'failed' });
    await openMenu('Codex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.about.harnessCheck' }));

    await screen.findByText('settings.about.harnessCheckFailed');
    expect(getBinaryVersion.mock.calls.filter(([kind, options]) => kind === 'codex' && options?.checkLatest)).toHaveLength(2);
    await openMenu('Codex');
    expect(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex.*1\.1\.0/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('settings.about.harnessCheckedAt')).toBeTruthy();
  });

  it('disables update when a later check rejects before returning a result', async () => {
    mockOnline({ codex: CODEX_UPDATE });

    renderRows();
    await screen.findByText('settings.about.harnessUpdateAvailable');

    getBinaryVersion.mockImplementation((kind: 'claude-code' | 'codex', options?: { checkLatest?: boolean }) => {
      if (kind === 'codex' && options?.checkLatest) return Promise.reject(new Error('ipc closed'));
      return Promise.resolve(versionResult(kind, options, null));
    });
    await openMenu('Codex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.about.harnessCheck' }));

    await screen.findByText('settings.about.harnessCheckFailed');
    await openMenu('Codex');
    expect(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex.*1\.1\.0/ }).getAttribute('aria-disabled')).toBe('true');
  });

  it('requires confirmation and relaunches only for the confirmed harness', async () => {
    mockOnline({ codex: CODEX_UPDATE });
    relaunchForHarnessUpdate.mockResolvedValue({ accepted: true });

    renderRows();
    await openMenu('Codex');

    fireEvent.click(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex/ }));
    await screen.findByText('settings.about.harnessUpdateDescription Codex');
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm Codex' }));
    await waitFor(() => expect(relaunchForHarnessUpdate).toHaveBeenCalledExactlyOnceWith('codex'));
  });

  it('asks again before a harness restart would interrupt in-flight work', async () => {
    mockOnline({ codex: CODEX_UPDATE });
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    relaunchForHarnessUpdate.mockResolvedValue({ accepted: true });

    renderRows();
    await openMenu('Codex');

    fireEvent.click(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.about.harnessUpdateConfirm Codex' }));
    await screen.findByText('settings.about.harnessUpdateBusyDescription Codex');
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm Codex' }));
    await waitFor(() => expect(relaunchForHarnessUpdate).toHaveBeenCalledExactlyOnceWith('codex'));
  });

  it('does not relaunch when the busy probe fails and the interruption warning is declined', async () => {
    mockOnline({ codex: CODEX_UPDATE });
    anyActivityBlockingRelaunch.mockRejectedValue(new Error('ipc channel closed'));

    renderRows();
    await openMenu('Codex');

    fireEvent.click(screen.getByRole('menuitem', { name: /harnessUpdateButton Codex/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.about.harnessUpdateConfirm Codex' }));
    await screen.findByText('settings.about.harnessUpdateBusyDescription Codex');
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateCancel' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalled());
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();
  });
});
