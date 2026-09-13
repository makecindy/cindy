// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserBackendHealth } from '../../../../shared/browserBackend';

const api = vi.hoisted(() => ({
  getPluginState: vi.fn(),
  setPluginEnabled: vi.fn(),
  getBrowserStatus: vi.fn(),
  getComputerStatus: vi.fn(),
  checkComputerUpdate: vi.fn(),
  updateComputerDriver: vi.fn(),
  getAndroidConfig: vi.fn(),
  getAndroidStatus: vi.fn(),
  getBackendState: vi.fn(),
  getBackendHealth: vi.fn(),
  setBackendKind: vi.fn(),
  recoverBackend: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  api.checkComputerUpdate.mockResolvedValue({ updateAvailable: false, updating: false });
  api.updateComputerDriver.mockResolvedValue({
    ok: true,
    stdout: '',
    stderr: '',
    status: computerUnavailable,
  });
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
          openForLogin: vi.fn(),
        },
        computer: {
          status: api.getComputerStatus,
          cancelPermissionGrant: vi.fn().mockResolvedValue({ cancelled: true }),
          onPermissionGuideStatusChanged: vi.fn(() => () => undefined),
          onPermissionGuideCancelled: vi.fn(() => () => undefined),
          onUpdateProgress: vi.fn(() => () => undefined),
          checkUpdate: api.checkComputerUpdate,
          updateDriver: api.updateComputerDriver,
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
  it('waits for computer plugin state before joining an in-flight driver update', async () => {
    const computerStatus = deferred<ComputerDriverStatus>();
    const computerPluginState = deferred<{ effectiveEnabled: boolean }>();
    const driverUpdate = deferred<ComputerDriverInstallResult>();
    api.getComputerStatus.mockReturnValueOnce(computerStatus.promise);
    api.getPluginState.mockImplementation((id: string) =>
      id === 'computer'
        ? computerPluginState.promise
        : Promise.resolve({ effectiveEnabled: id === 'browser' }),
    );
    api.checkComputerUpdate.mockResolvedValueOnce({
      updateAvailable: false,
      updating: true,
      currentVersion: '0.12.2',
      latestVersion: '0.12.3',
    });
    api.updateComputerDriver.mockReturnValueOnce(driverUpdate.promise);

    render(<ComputerUseSection workingDir="/tmp/project" />);

    await act(async () => {
      computerStatus.resolve({
        ...computerUnavailable,
        installed: true,
        version: '0.12.2',
      });
      await computerStatus.promise;
    });
    expect(api.checkComputerUpdate).not.toHaveBeenCalled();

    await act(async () => {
      computerPluginState.resolve({ effectiveEnabled: true });
      await computerPluginState.promise;
    });
    await waitFor(() => expect(api.updateComputerDriver).toHaveBeenCalledWith({ joinOnly: true }));

    await act(async () => {
      driverUpdate.resolve({
        ok: true,
        stdout: '',
        stderr: '',
        status: {
          ...computerUnavailable,
          installed: true,
          permissionState: {
            platform: 'linux',
            required: true,
            status: 'missing',
            canGrant: false,
          },
        },
      });
      await driverUpdate.promise;
    });
    await waitFor(() => expect(api.setPluginEnabled).toHaveBeenCalledWith('computer', false));
  });

  it('keeps the initial driver update result when plugin state resolves later', async () => {
    const computerPluginState = deferred<{ effectiveEnabled: boolean }>();
    const driverUpdate = deferred<ComputerDriverUpdateCheck>();
    api.getPluginState.mockImplementation((id: string) =>
      id === 'computer'
        ? computerPluginState.promise
        : Promise.resolve({ effectiveEnabled: id === 'browser' }),
    );
    api.getComputerStatus.mockResolvedValueOnce({
      ...computerUnavailable,
      installed: true,
      version: '0.12.2',
    });
    api.checkComputerUpdate.mockReturnValueOnce(driverUpdate.promise);

    render(<ComputerUseSection workingDir="/tmp/project" />);

    await act(async () => {
      computerPluginState.resolve({ effectiveEnabled: false });
      await computerPluginState.promise;
    });
    await waitFor(() => expect(api.checkComputerUpdate).toHaveBeenCalledTimes(1));
    await act(async () => {
      driverUpdate.resolve({
        updateAvailable: true,
        updating: false,
        currentVersion: '0.12.2',
        latestVersion: '0.12.3',
      });
      await driverUpdate.promise;
    });

    expect(
      await screen.findByText('settings.computerUse.directControl.update.available'),
    ).toBeTruthy();
    expect(api.checkComputerUpdate).toHaveBeenCalledTimes(1);
  });

  it('renders the base settings before browser status resolves', async () => {
    const browserStatus = deferred<BrowserAvailability>();
    const computerStatus = deferred<ComputerDriverStatus>();
    api.getBrowserStatus.mockReturnValueOnce(browserStatus.promise);
    api.getComputerStatus.mockReturnValueOnce(computerStatus.promise);
    api.getBackendState.mockResolvedValueOnce({ active: 'external' });
    api.getBackendHealth.mockResolvedValueOnce({
      active: 'external',
      status: 'ready',
      canRecover: false,
    });

    render(<ComputerUseSection workingDir="/tmp/project" />);

    expect(screen.getByText('settings.computerUse.title')).toBeTruthy();
    expect(screen.getByText('settings.computerUse.browser.title')).toBeTruthy();
    expect(screen.getByText('settings.computerUse.directControl.title')).toBeTruthy();
    expect(screen.getByText('settings.computerUse.android.title')).toBeTruthy();
    expect(
      (screen.getByRole('switch', {
        name: 'settings.computerUse.browser.toggleAria',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    expect(
      await screen.findByRole('radio', {
        name: 'settings.computerUse.browserBackend.external.title',
      }),
    ).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.browser.notDetected')).toBeNull();
    expect(
      (screen.getByRole('switch', {
        name: 'settings.computerUse.directControl.toggleAria',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('switch', {
        name: 'settings.computerUse.android.toggleAria',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      browserStatus.resolve({
        detected: false,
        browserKind: null,
        executablePath: null,
      });
      await browserStatus.promise;
    });

    expect(await screen.findByText('settings.computerUse.browser.notDetected')).toBeTruthy();
    expect(
      (screen.getByRole('switch', {
        name: 'settings.computerUse.android.toggleAria',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      computerStatus.resolve(computerUnavailable);
      await computerStatus.promise;
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('switch', {
          name: 'settings.computerUse.directControl.toggleAria',
        }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole('switch', {
        name: 'settings.computerUse.android.toggleAria',
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
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
