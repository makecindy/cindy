// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { translate } = vi.hoisted(() => ({
  translate: (key: string, args?: { version?: string; time?: string }) =>
    args?.version || args?.time ? `${key}: ${args.version ?? args.time}` : key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('@/lib/toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from '@/lib/toast';
import { ComputerUseSection } from '../ComputerUseSection';

const updateKey = 'settings.computerUse.directControl.update';
const versionKey = 'settings.computerUse.directControl.status.version';
const oldVersion = '0.33.0';
const newVersion = '0.33.1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function driverStatus(version = oldVersion, macos = false): ComputerDriverStatus {
  return {
    installed: true, version, executablePath: 'cua-driver', daemonRunning: true,
    installCommand: 'noop', docsUrl: 'https://example.invalid/docs',
    permissionState: {
      platform: macos ? 'macos' : 'windows', required: macos, canGrant: macos,
      status: macos ? 'granted' : 'not_required',
      accessibility: 'granted', screenRecording: 'granted', screenRecordingCapturable: 'granted',
    },
  };
}

const offer: ComputerDriverUpdateCheck = {
  currentVersion: '0.33.0', latestVersion: '0.33.1', updateAvailable: true, updating: false,
};
const upToDate: ComputerDriverUpdateCheck = {
  ...offer, currentVersion: '0.33.1', updateAvailable: false,
};
function installed(macos = false): ComputerDriverInstallResult {
  return { ok: true, stdout: '', stderr: '', status: driverStatus(newVersion, macos) };
}

function installApi(macos = false) {
  const computer = {
    status: vi.fn<(...args: unknown[]) => Promise<ComputerDriverStatus>>()
      .mockResolvedValue(driverStatus(oldVersion, macos)),
    checkUpdate: vi.fn().mockResolvedValueOnce(offer).mockResolvedValue(upToDate),
    updateDriver: vi.fn().mockResolvedValue(installed(macos)),
    onPermissionGuideStatusChanged: vi.fn(() => () => {}),
    onPermissionGuideCancelled: vi.fn(() => () => {}),
    onUpdateProgress: vi.fn(() => () => {}),
    cancelPermissionGrant: vi.fn(async () => {}),
  };
  const setEnabled = vi.fn(async () => ({ codexMcpRefreshed: true }));
  const getState = vi.fn(async (pluginId: string) => ({ effectiveEnabled: pluginId === 'computer' }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: macos ? 'darwin' : 'win32',
      maker: {
        plugins: {
          getState,
          setEnabled,
        },
        browser: { status: vi.fn(async () => ({ detected: false })) },
        computer,
        android: { getConfig: vi.fn(async () => ({ value: {} })) },
      },
    },
  });
  return { computer, setEnabled, getState };
}

async function clickUpdate() {
  fireEvent.click(await screen.findByRole('button', { name: `${updateKey}.action` }));
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
  vi.clearAllMocks();
});

describe('ComputerUseSection driver update completion', () => {
  it.each(['response', 'rejection'])('labels a retained offer after a failed recheck (%s)', async (failure) => {
    const { computer } = installApi();
    render(<ComputerUseSection />);
    await screen.findByText(`${updateKey}.available: ${newVersion}`);
    if (failure === 'response') computer.checkUpdate.mockResolvedValue({ ...offer, checkStatus: 'error' });
    else computer.checkUpdate.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: `${updateKey}.check` }));
    await screen.findByText(`${updateKey}.checkFailed`);
    expect(screen.getByText(`${updateKey}.previouslyAvailable: ${newVersion}`)).toBeTruthy();
    expect(screen.queryByText(`${updateKey}.available: ${newVersion}`)).toBeNull();
    expect((screen.getByRole('button', { name: `${updateKey}.action` }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: `${updateKey}.retry` })).toBeTruthy();
  });

  it('finishes local permission recovery even when the post-install network check is slow', async () => {
    const { computer, setEnabled } = installApi(true);
    const check = deferred<ComputerDriverUpdateCheck>();
    render(<ComputerUseSection />);
    await screen.findByText(`${updateKey}.available: ${newVersion}`);
    computer.checkUpdate.mockReturnValue(check.promise);
    computer.status.mockRejectedValue(new Error('permission probe unavailable'));
    await clickUpdate();
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith('computer', false));
    expect(computer.status).toHaveBeenCalledWith({ forcePermissionProbe: true, freshPermissionProbe: true });
    expect(toast.warning).toHaveBeenCalledWith('settings.computerUse.directControl.toast.permissionPending');
    await screen.findByText(`${updateKey}.checking`);
    expect(screen.getByText(`${versionKey}: ${newVersion}`)).toBeTruthy();
    expect(screen.queryByText(`${updateKey}.updating`)).toBeNull();
    await act(async () => { check.resolve(upToDate); });
  });

  it('distinguishes reading the local version from checking for updates and shows the final result', async () => {
    const { computer } = installApi();
    const status = deferred<ComputerDriverStatus>();
    const check = deferred<ComputerDriverUpdateCheck>();
    computer.status.mockReturnValue(status.promise);
    computer.checkUpdate.mockReset().mockReturnValue(check.promise);
    render(<ComputerUseSection />);
    await screen.findByText(`${updateKey}.readingVersion`);
    expect(computer.checkUpdate).not.toHaveBeenCalled();
    await act(async () => { status.resolve(driverStatus()); });
    await screen.findByText(`${updateKey}.checking`);
    expect(screen.queryByText(`${updateKey}.upToDate`)).toBeNull();
    expect((screen.getByRole('button', { name: `${updateKey}.check` }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { check.resolve({ ...upToDate, checkStatus: 'success', checkedAt: Date.now() }); });
    await screen.findByText(`${updateKey}.upToDate`);
    expect(screen.getByText(new RegExp(`${updateKey}.lastChecked:`))).toBeTruthy();
    expect(screen.queryByText(`${updateKey}.checking`)).toBeNull();
  });

  it.each(['response', 'rejection'])('shows a failed check and lets retry bypass the cache (%s)', async (failure) => {
    const { computer } = installApi();
    computer.checkUpdate.mockReset();
    if (failure === 'response') {
      computer.checkUpdate.mockResolvedValueOnce({ ...offer, latestVersion: null, updateAvailable: false, checkStatus: 'error' });
    } else {
      computer.checkUpdate.mockRejectedValueOnce(new Error('offline'));
    }
    const retry = deferred<ComputerDriverUpdateCheck>();
    computer.checkUpdate.mockReturnValue(retry.promise);
    render(<ComputerUseSection />);
    await screen.findByText(`${updateKey}.checkFailed`);
    expect(screen.queryByText(`${updateKey}.upToDate`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${updateKey}.retry` }));
    expect(computer.checkUpdate).toHaveBeenLastCalledWith({ force: true });
    await screen.findByText(`${updateKey}.checking`);
    await act(async () => { retry.resolve(offer); });
    await screen.findByText(`${updateKey}.available: ${newVersion}`);
    expect(screen.queryByText(`${updateKey}.checkFailed`)).toBeNull();
  });

  it('keeps manual checking available when up to date and displays a newly found update', async () => {
    const { computer } = installApi();
    computer.checkUpdate.mockReset().mockResolvedValueOnce(upToDate).mockResolvedValue(offer);
    render(<ComputerUseSection />);
    await screen.findByText(`${updateKey}.upToDate`);
    fireEvent.click(screen.getByRole('button', { name: `${updateKey}.check` }));
    await screen.findByText(`${updateKey}.available: ${newVersion}`);
    expect(computer.checkUpdate).toHaveBeenLastCalledWith({ force: true });
  });

  it('still joins an update when opt-in loading changes the callback during its check', async () => {
    const { computer, getState } = installApi();
    const optIn = deferred<{ effectiveEnabled: boolean }>();
    const check = deferred<ComputerDriverUpdateCheck>();
    getState.mockImplementation((pluginId) => pluginId === 'computer'
      ? optIn.promise : Promise.resolve({ effectiveEnabled: false }));
    computer.checkUpdate.mockReset().mockReturnValue(check.promise);
    render(<ComputerUseSection />);
    await waitFor(() => expect(computer.checkUpdate).toHaveBeenCalledOnce());
    await act(async () => { optIn.resolve({ effectiveEnabled: true }); });
    computer.checkUpdate.mockResolvedValue(upToDate);
    await act(async () => { check.resolve({ ...offer, updating: true }); });
    await screen.findByText(`${versionKey}: ${newVersion}`);
    expect(computer.updateDriver).toHaveBeenCalledExactlyOnceWith({ joinOnly: true });
    expect(screen.queryByRole('button', { name: `${updateKey}.action` })).toBeNull();
  });

  it('shows the installed version and clears the offer on success', async () => {
    installApi();
    render(<ComputerUseSection />);
    await clickUpdate();
    await screen.findByText(`${versionKey}: ${newVersion}`);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`${updateKey}.toast.success`));
    expect(screen.queryByText(`${updateKey}.available: 0.33.1`)).toBeNull();
    expect(screen.queryByRole('button', { name: `${updateKey}.action` })).toBeNull();
  });

  it.each([true, false])('refreshes actual state after an installer error (binary replaced: %s)', async (replaced) => {
    const { computer } = installApi();
    computer.updateDriver.mockRejectedValue(new Error('installer cleanup failed'));
    render(<ComputerUseSection />);
    await screen.findByText(`${versionKey}: ${oldVersion}`);
    computer.status.mockResolvedValue(driverStatus(replaced ? newVersion : oldVersion));
    computer.checkUpdate.mockResolvedValue(replaced ? upToDate : offer);
    await clickUpdate();
    await waitFor(() => expect(computer.status).toHaveBeenCalledWith({ skipPermissionProbe: true }));
    await waitFor(() => expect(computer.checkUpdate).toHaveBeenCalledTimes(2));
    await screen.findByText(`${versionKey}: ${replaced ? newVersion : oldVersion}`);
    await waitFor(() => {
      const button = screen.queryByRole('button', { name: `${updateKey}.action` });
      if (replaced) expect(button).toBeNull();
      else expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('publishes the new version before a slow permission check and reports its failure separately', async () => {
    const { computer, setEnabled } = installApi(true);
    const permissions = deferred<ComputerDriverStatus>();
    render(<ComputerUseSection />);
    await screen.findByText(`${versionKey}: ${oldVersion}`);
    computer.status.mockReturnValue(permissions.promise);
    await clickUpdate();
    await screen.findByText(`${versionKey}: ${newVersion}`);
    expect(screen.queryByRole('button', { name: `${updateKey}.action` })).toBeNull();
    await act(async () => { permissions.reject(new Error('permission probe failed')); });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'settings.computerUse.directControl.toast.permissionPending',
    ));
    expect(toast.error).not.toHaveBeenCalled();
    expect(setEnabled).toHaveBeenCalledWith('computer', false);
    expect(screen.getByText(`${versionKey}: ${newVersion}`)).toBeTruthy();
    expect(screen.queryByText(`${updateKey}.available: 0.33.1`)).toBeNull();
  });

  it('keeps the verified version when the permission probe returns an unavailable status', async () => {
    const { computer } = installApi(true);
    render(<ComputerUseSection />);
    await screen.findByText(`${versionKey}: ${oldVersion}`);
    computer.status.mockResolvedValue({
      ...driverStatus(newVersion, true), installed: false, version: null,
      permissionState: { platform: 'macos', required: true, canGrant: true, status: 'unknown' },
    });
    await clickUpdate();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(screen.getByText(`${versionKey}: ${newVersion}`)).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([true, false])('joins the existing update after reopening (installer succeeds: %s)', async (succeeds) => {
    const { computer } = installApi();
    const installation = deferred<ComputerDriverInstallResult>();
    computer.updateDriver.mockReturnValue(installation.promise);
    const first = render(<ComputerUseSection />);
    await clickUpdate();
    first.unmount();
    computer.checkUpdate.mockResolvedValue({ ...offer, updating: true });
    render(<ComputerUseSection />);
    await waitFor(() => expect(computer.updateDriver).toHaveBeenLastCalledWith({ joinOnly: true }));
    computer.status.mockResolvedValue(driverStatus(newVersion));
    computer.checkUpdate.mockResolvedValue(upToDate);
    await act(async () => {
      if (succeeds) installation.resolve(installed());
      else installation.reject(new Error('installer cleanup failed'));
    });
    await screen.findByText(`${versionKey}: ${newVersion}`);
    expect(computer.updateDriver.mock.calls).toEqual([[undefined], [{ joinOnly: true }]]);
    expect(screen.queryByRole('button', { name: `${updateKey}.action` })).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    expect(toast.error).toHaveBeenCalledTimes(succeeds ? 0 : 1);
  });
});
