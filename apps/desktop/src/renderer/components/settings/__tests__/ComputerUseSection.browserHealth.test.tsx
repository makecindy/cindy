// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserBackendHealth } from '../../../../shared/browserBackend';
import { readComputerStatusForSettings } from '../../../../main/maker-ipc/computerStatusHandler';

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ComputerUseSection browser backend health loading', () => {
  // Regression: the four base reads used to gate the entire page via Promise.all.
  // Existing tests cover slow runtime probes only. A never-settling base read
  // must leave the other cards and their loaded controls usable (unit/jsdom).
  it.each(['browser', 'computer', 'availability', 'backend'])(
    'keeps other settings usable while %s configuration never returns',
    async (pending) => {
      const never = new Promise<never>(() => {});
      if (pending === 'availability') api.getBrowserStatus.mockReturnValue(never);
      else if (pending === 'backend') api.getBackendState.mockReturnValue(never);
      else
        api.getPluginState.mockImplementation(async (id: string) =>
          id === pending ? never : { effectiveEnabled: id === 'browser' },
        );

      await act(async () => {
        render(<ComputerUseSection workingDir="/tmp/project" />);
      });

      expect(screen.getByText('settings.computerUse.title')).toBeTruthy();
      expect(screen.getByText('settings.computerUse.android.title')).toBeTruthy();
      const browserSwitch = screen.getByRole('switch', {
        name: 'settings.computerUse.browser.toggleAria',
      }) as HTMLButtonElement;
      expect(browserSwitch.disabled).toBe(pending === 'browser');
      expect(
        (
          screen.getByRole('switch', {
            name: 'settings.computerUse.android.toggleAria',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      if (pending !== 'backend') {
        expect(
          screen.getByRole('radio', {
            name: 'settings.computerUse.browserBackend.rsbWebview.title',
          }),
        ).toBeTruthy();
      }
    },
  );

  it('automatically recovers a failed read without presenting a default as persisted state', async () => {
    vi.useFakeTimers();
    let failed = false;
    api.getPluginState.mockImplementation((id: string) => {
      if (id === 'browser' && !failed) {
        failed = true;
        throw new Error('bridge unavailable');
      }
      return Promise.resolve({ effectiveEnabled: id === 'browser' });
    });
    await act(async () => {
      render(<ComputerUseSection workingDir="/tmp/project" />);
    });
    const toggle = screen.getByRole('switch', {
      name: 'settings.computerUse.browser.toggleAria',
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('settings.computerUse.configurationRead.retrying')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('settings.computerUse.configurationRead.retrying')).toBeNull();
  });

  it('bounds timeout retries, allows manual recovery, and ignores a late timed-out result', async () => {
    vi.useFakeTimers();
    const initialDetection = deferred<BrowserAvailability>();
    api.getBackendState.mockResolvedValue({ active: 'external' });
    api.getBrowserStatus.mockReturnValue(initialDetection.promise);
    await act(async () => {
      render(<ComputerUseSection workingDir="/tmp/project" />);
    });
    expect(screen.queryByText('settings.computerUse.browser.notDetected')).toBeNull();
    expect(screen.queryByText('settings.computerUse.browser.download')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(screen.getByText('settings.computerUse.configurationRead.error')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getBrowserStatus).toHaveBeenCalledTimes(2);
    expect(
      (
        screen.getByRole('switch', {
          name: 'settings.computerUse.browser.toggleAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    api.getBrowserStatus.mockResolvedValue({
      detected: true,
      browserKind: 'chrome',
      executablePath: '/chrome',
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.computerUse.configurationRead.retry' }),
      );
    });
    expect(screen.getByText('settings.computerUse.browser.openForLogin')).toBeTruthy();
    await act(async () => {
      initialDetection.resolve({ detected: false, browserKind: null, executablePath: null });
    });
    expect(screen.getByText('settings.computerUse.browser.openForLogin')).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.browser.download')).toBeNull();
  });

  it('ignores the previous project read after switching projects', async () => {
    const previous = deferred<{ effectiveEnabled: boolean }>();
    api.getPluginState.mockImplementation(async (id: string, directory?: string) =>
      id === 'browser' && directory === '/tmp/previous'
        ? previous.promise
        : { effectiveEnabled: false },
    );
    const { rerender } = render(<ComputerUseSection workingDir="/tmp/previous" />);
    await act(async () => {
      rerender(<ComputerUseSection workingDir="/tmp/current" />);
    });
    const toggle = screen.getByRole('switch', {
      name: 'settings.computerUse.browser.toggleAria',
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      previous.resolve({ effectiveEnabled: true });
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the current project read alive when a previous project save completes', async () => {
    const save = deferred<void>();
    const current = deferred<{ effectiveEnabled: boolean }>();
    vi.mocked(window.electronAPI.maker.plugins.setProjectEnabled).mockReturnValue(save.promise);
    api.getPluginState.mockImplementation(async (id: string, directory?: string) =>
      id === 'browser' && directory === '/tmp/current'
        ? current.promise
        : { effectiveEnabled: id === 'browser' },
    );
    const { rerender } = render(<ComputerUseSection workingDir="/tmp/previous" />);
    const toggle = (await screen.findByRole('switch', {
      name: 'settings.computerUse.browser.toggleAria',
    })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    await act(async () => {
      rerender(<ComputerUseSection workingDir="/tmp/current" />);
    });
    await act(async () => {
      save.resolve();
    });
    expect(toggle.disabled).toBe(true);
    await act(async () => {
      current.resolve({ effectiveEnabled: true });
    });
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('cancels pending recovery when the panel is closed', async () => {
    vi.useFakeTimers();
    api.getBackendState.mockRejectedValue(new Error('unavailable'));
    const { unmount } = render(<ComputerUseSection workingDir="/tmp/project" />);
    await act(async () => {});
    expect(screen.getByText('settings.computerUse.configurationRead.retrying')).toBeTruthy();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.getBackendState).toHaveBeenCalledTimes(1);
  });

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
    expect(
      screen.getByText('settings.computerUse.directControl.update.readingVersion'),
    ).toBeTruthy();
    expect(screen.queryByText('settings.computerUse.directControl.notDetected')).toBeNull();
    expect(api.getComputerStatus).toHaveBeenCalledWith({
      refreshPermissionGuide: false,
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    });

    fireEvent.click(
      await screen.findByRole('radio', {
        name: 'settings.computerUse.browserBackend.external.title',
      }),
    );
    await waitFor(() => expect(api.setBackendKind).toHaveBeenCalledWith('external'));
    rerender(<ComputerUseSection workingDir="/tmp/other-project" />);
    expect(api.getComputerStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      initialComputer.resolve(computerUnavailable);
    });
    expect((computerToggle as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.queryByText('settings.computerUse.directControl.update.readingVersion'),
    ).toBeNull();
  });

  it('settles a failed computer probe without hiding the settings', async () => {
    api.getComputerStatus.mockRejectedValueOnce(new Error('probe failed'));
    await act(async () => {
      render(<ComputerUseSection workingDir="/tmp/project" />);
    });
    expect(await screen.findByText('settings.computerUse.title')).toBeTruthy();
    expect(
      screen.queryByText('settings.computerUse.directControl.update.readingVersion'),
    ).toBeNull();
    expect(
      (
        screen.getByRole('switch', {
          name: 'settings.computerUse.directControl.toggleAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('preserves a newer native status when the initial probe returns late', async () => {
    const initialComputer = deferred<ComputerDriverStatus>();
    // Use the real IPC business handler: forced reads normally broadcast before
    // resolving, which must not overwrite a newer guide event for page entry.
    const broadcast = vi.fn((status: ComputerDriverStatus) => {
      vi.mocked(window.electronAPI.maker.computer.onPermissionGuideStatusChanged).mock.calls.at(
        -1,
      )![0](status);
    });
    api.getComputerStatus.mockImplementationOnce((options) =>
      readComputerStatusForSettings(options, {
        getStatus: () => initialComputer.promise,
        refreshPermissionGuide: broadcast,
      }),
    );
    vi.mocked(window.electronAPI.maker.computer.checkUpdate).mockResolvedValue({
      currentVersion: '0.12.2',
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
    render(<ComputerUseSection workingDir="/tmp/project" />);
    await screen.findByText('settings.computerUse.title');
    const onStatus = vi
      .mocked(window.electronAPI.maker.computer.onPermissionGuideStatusChanged)
      .mock.calls.at(-1)![0];
    await act(async () => {
      onStatus({ ...computerUnavailable, installed: true, version: '0.12.2' });
    });
    expect(screen.getByText('settings.computerUse.directControl.status.version')).toBeTruthy();
    await act(async () => {
      initialComputer.resolve(computerUnavailable);
    });
    expect(broadcast).not.toHaveBeenCalled();
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
