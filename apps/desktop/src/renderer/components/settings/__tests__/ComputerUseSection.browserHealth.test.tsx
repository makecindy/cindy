// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserBackendHealth } from '../../../../shared/browserBackend';

const api = vi.hoisted(() => ({
  getPluginState: vi.fn(),
  setPluginEnabled: vi.fn(),
  getBrowserStatus: vi.fn(),
  getComputerStatus: vi.fn(),
  getAndroidConfig: vi.fn(),
  getAndroidStatus: vi.fn(),
  getBackendState: vi.fn(),
  getBackendHealth: vi.fn(),
  setBackendKind: vi.fn(),
  recoverBackend: vi.fn(),
  openForLogin: vi.fn(),
  warningToast: vi.fn(),
  successToast: vi.fn(),
  errorToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: api.warningToast, success: api.successToast, error: api.errorToast },
}));

import { ComputerUseSection } from '../ComputerUseSection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const computerUnavailable: ComputerDriverStatus = {
  installed: false,
  executablePath: null,
  version: null,
  daemonRunning: false,
  installCommand: 'install cua-driver',
  docsUrl: 'https://cua.ai/docs/cua-driver',
};

const androidUnavailable: AndroidStatusSummary = {
  adb_available: false,
  adb_path: null,
  version: null,
  devices: [],
  issue: 'ADB_NOT_FOUND',
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getPluginState.mockImplementation(async (id: string) => ({
    effectiveEnabled: id === 'browser',
  }));
  api.setPluginEnabled.mockResolvedValue({ codexMcpRefreshed: true });
  api.getBrowserStatus.mockResolvedValue({
    detected: false,
    browserKind: null,
    executablePath: null,
  });
  api.getComputerStatus.mockResolvedValue(computerUnavailable);
  api.getAndroidConfig.mockResolvedValue({
    value: { defaultDeviceSerial: null, adbPathOverride: null },
    defaults: { defaultDeviceSerial: null, adbPathOverride: null },
    isCustomized: false,
    customizedKeys: [],
  });
  api.getAndroidStatus.mockResolvedValue(androidUnavailable);
  api.getBackendState.mockResolvedValue({ active: 'rsb-webview' });
  api.setBackendKind.mockImplementation(async (kind: 'external' | 'rsb-webview') => ({
    active: kind,
  }));
  api.recoverBackend.mockResolvedValue({
    ok: true,
    health: { active: 'rsb-webview', status: 'ready', canRecover: true },
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      openExternal: vi.fn().mockResolvedValue({ success: true }),
      maker: {
        plugins: {
          getState: api.getPluginState,
          setEnabled: api.setPluginEnabled,
          setProjectEnabled: vi.fn(),
        },
        browser: {
          status: api.getBrowserStatus,
          openForLogin: api.openForLogin,
        },
        computer: {
          status: api.getComputerStatus,
          cancelPermissionGrant: vi.fn().mockResolvedValue({ cancelled: true }),
          onPermissionGuideStatusChanged: vi.fn(() => () => undefined),
          onPermissionGuideCancelled: vi.fn(() => () => undefined),
          onUpdateProgress: vi.fn(() => () => undefined),
          checkUpdate: vi.fn(),
        },
        android: {
          getConfig: api.getAndroidConfig,
          status: api.getAndroidStatus,
          prepareAdb: vi.fn(),
        },
      },
      browserBackend: {
        getState: api.getBackendState,
        getHealth: api.getBackendHealth,
        setKind: api.setBackendKind,
        recover: api.recoverBackend,
        setUseRealProfile: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
      },
    },
  });
});

afterEach(cleanup);

describe('ComputerUseSection browser backend health loading', () => {
  it('renders other settings while computer permission detection is pending', async () => {
    const initialComputer = deferred<ComputerDriverStatus>();
    api.getComputerStatus.mockReturnValueOnce(initialComputer.promise);
    const { rerender } = render(<ComputerUseSection workingDir="/tmp/project" />);

    expect(await screen.findByText('settings.computerUse.title')).toBeTruthy();
    expect(screen.getByText('settings.computerUse.android.title')).toBeTruthy();
    const computerToggle = screen.getByRole('switch', {
      name: 'settings.computerUse.directControl.toggleAria',
    });
    expect((computerToggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('settings.computerUse.directControl.status.checking')).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.directControl.status.notInstalled')).toBeNull();
    expect(api.getComputerStatus).toHaveBeenCalledWith({
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    });

    fireEvent.click(screen.getByRole('radio', {
      name: 'settings.computerUse.browserBackend.external.title',
    }));
    await waitFor(() => expect(api.setBackendKind).toHaveBeenCalledWith('external'));
    rerender(<ComputerUseSection workingDir="/tmp/other-project" />);
    expect(api.getComputerStatus).toHaveBeenCalledTimes(1);

    await act(async () => { initialComputer.resolve(computerUnavailable); });
    expect((computerToggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('settings.computerUse.directControl.status.checking')).toBeNull();
  });

  it('settles a failed computer probe without hiding the settings', async () => {
    api.getComputerStatus.mockRejectedValueOnce(new Error('probe failed'));
    render(<ComputerUseSection workingDir="/tmp/project" />);
    expect(await screen.findByText('settings.computerUse.title')).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.directControl.status.checking')).toBeNull();
    expect((screen.getByRole('switch', {
      name: 'settings.computerUse.directControl.toggleAria',
    }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('preserves a newer native status when the initial probe returns late', async () => {
    const initialComputer = deferred<ComputerDriverStatus>();
    api.getComputerStatus.mockReturnValueOnce(initialComputer.promise);
    vi.mocked(window.electronAPI.maker.computer.checkUpdate).mockResolvedValue({
      currentVersion: '0.12.2',
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
    render(<ComputerUseSection workingDir="/tmp/project" />);
    await screen.findByText('settings.computerUse.title');
    const onStatus = vi.mocked(window.electronAPI.maker.computer.onPermissionGuideStatusChanged)
      .mock.calls.at(-1)![0];
    await act(async () => {
      onStatus({ ...computerUnavailable, installed: true, version: '0.12.2' });
    });
    expect(screen.getByText('settings.computerUse.directControl.status.version')).toBeTruthy();
    await act(async () => { initialComputer.resolve(computerUnavailable); });
    expect(screen.getByText('settings.computerUse.directControl.status.version')).toBeTruthy();
  });

  it('keeps optional copy diagnostics out of user-facing launch notifications', async () => {
    api.getBackendState.mockResolvedValue({ active: 'external' });
    api.getBackendHealth.mockResolvedValue({
      active: 'external',
      status: 'ready',
      canRecover: false,
    });
    api.getBrowserStatus.mockResolvedValue({
      detected: true,
      browserKind: 'chrome',
      executablePath: '/chrome',
    });
    api.openForLogin.mockResolvedValue({
      launched: true,
      warnings: [
        { database: 'Login Data', reason: 'locked' },
        { database: 'Login Data For Account', reason: 'locked' },
        { database: 'Web Data', reason: 'permission-denied' },
      ],
    });
    render(<ComputerUseSection workingDir="/tmp/project" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.computerUse.browser.openForLogin' }),
    );
    await waitFor(() =>
      expect(api.successToast).toHaveBeenCalledWith(
        'settings.computerUse.browser.toast.openedForLogin',
      ),
    );
    expect(api.warningToast).not.toHaveBeenCalled();
    expect(api.errorToast).not.toHaveBeenCalled();
  });

  it('renders the Automation settings while the recoverable health probe is still pending', async () => {
    const initialHealth = deferred<BrowserBackendHealth>();
    api.getBackendHealth.mockReturnValueOnce(initialHealth.promise);

    render(<ComputerUseSection workingDir="/tmp/project" />);

    expect(await screen.findByText('settings.computerUse.title')).toBeTruthy();
    expect(
      screen.getByRole('radio', {
        name: 'settings.computerUse.browserBackend.rsbWebview.title',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => {
      initialHealth.resolve({
        active: 'rsb-webview',
        status: 'ready',
        canRecover: true,
      });
      await initialHealth.promise;
    });

    expect((await screen.findByRole('status')).textContent).toContain(
      'settings.computerUse.browserBackend.health.ready',
    );
  });

  it('does not let a late initial health result overwrite a newer backend selection', async () => {
    const initialHealth = deferred<BrowserBackendHealth>();
    api.getBackendHealth
      .mockReturnValueOnce(initialHealth.promise)
      .mockResolvedValueOnce({ active: 'external', status: 'ready', canRecover: false })
      .mockResolvedValueOnce({ active: 'rsb-webview', status: 'ready', canRecover: true });

    render(<ComputerUseSection workingDir="/tmp/project" />);

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.computerUse.browserBackend.external.title',
      }),
    );
    await waitFor(() => expect(api.setBackendKind).toHaveBeenCalledWith('external'));
    await waitFor(() =>
      expect(
        screen
          .getByRole('radio', {
            name: 'settings.computerUse.browserBackend.external.title',
          })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'settings.computerUse.browserBackend.rsbWebview.title',
      }),
    );
    await waitFor(() => expect(api.setBackendKind).toHaveBeenCalledWith('rsb-webview'));
    expect((await screen.findByRole('status')).textContent).toContain(
      'settings.computerUse.browserBackend.health.ready',
    );

    await act(async () => {
      initialHealth.resolve({
        active: 'rsb-webview',
        status: 'error',
        canRecover: true,
        reason: 'disposing',
      });
      await initialHealth.promise;
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'settings.computerUse.browserBackend.health.ready',
    );
  });
});
