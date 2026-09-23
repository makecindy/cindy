// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) => key,
  }),
}));

import { AgentVersionsRows } from '../AboutSection';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

const getBinaryVersion = vi.fn();
const getState = vi.fn();
const relaunchForHarnessUpdate = vi.fn();
const anyActivityBlockingRelaunch = vi.fn();

function versionResult(
  kind: string,
  options: { checkLatest?: boolean } | undefined,
  online: { latestVersion: string; updateAvailable: boolean } | null,
) {
  const local = { kind, binaryPath: `/${kind}`, version: '1.0.0' };
  if (!options?.checkLatest || !online) return { ...local, latestVersion: null, updateAvailable: false };
  return { ...local, ...online };
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
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      Promise.resolve(versionResult(kind, options, null)),
    );

    renderRows();

    await waitFor(() => expect(screen.getByText('settings.about.version.notReady')).toBeTruthy());
  });

  it('shows the local version without waiting for the online comparison', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      options?.checkLatest ? new Promise(() => {}) : Promise.resolve(versionResult(kind, options, null)),
    );

    renderRows();

    await waitFor(() => expect(screen.getAllByText('1.0.0')).toHaveLength(2));
    expect(screen.queryByText('settings.about.version.loading')).toBeNull();
  });

  it('shows an update button only when Main reports a newer online version', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      Promise.resolve(
        versionResult(kind, options, kind === 'codex'
          ? { latestVersion: '1.1.0', updateAvailable: true }
          // A local build newer than the channel manifest differs but is not an update.
          : { latestVersion: '0.9.0', updateAvailable: false }),
      ),
    );

    renderRows();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' })).toBeTruthy();
    });
    expect(screen.getAllByRole('button', { name: 'settings.about.harnessUpdateButton' })).toHaveLength(1);
  });

  it('requires confirmation and relaunches only for the confirmed harness', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      Promise.resolve(
        versionResult(kind, options, kind === 'codex' ? { latestVersion: '1.1.0', updateAvailable: true } : null),
      ),
    );
    relaunchForHarnessUpdate.mockResolvedValue({ accepted: true });

    renderRows();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' }));
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm' }));
    await waitFor(() => expect(relaunchForHarnessUpdate).toHaveBeenCalledExactlyOnceWith('codex'));
  });

  it('asks again before a harness restart would interrupt in-flight work', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      Promise.resolve(
        versionResult(kind, options, kind === 'codex' ? { latestVersion: '1.1.0', updateAvailable: true } : null),
      ),
    );
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    relaunchForHarnessUpdate.mockResolvedValue({ accepted: true });

    renderRows();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm' }));
    await waitFor(() => {
      expect(screen.getByText('settings.about.harnessUpdateBusyDescription')).toBeTruthy();
    });
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm' }));
    await waitFor(() => expect(relaunchForHarnessUpdate).toHaveBeenCalledExactlyOnceWith('codex'));
  });

  it('does not relaunch when the busy probe fails and the interruption warning is declined', async () => {
    getBinaryVersion.mockImplementation((kind: string, options?: { checkLatest?: boolean }) =>
      Promise.resolve(
        versionResult(kind, options, kind === 'codex' ? { latestVersion: '1.1.0', updateAvailable: true } : null),
      ),
    );
    anyActivityBlockingRelaunch.mockRejectedValue(new Error('ipc channel closed'));

    renderRows();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateConfirm' }));
    await waitFor(() => {
      expect(screen.getByText('settings.about.harnessUpdateBusyDescription')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.harnessUpdateCancel' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalled());
    expect(relaunchForHarnessUpdate).not.toHaveBeenCalled();
  });
});
