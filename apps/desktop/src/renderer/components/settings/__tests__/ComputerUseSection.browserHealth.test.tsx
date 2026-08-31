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
  it('renders the Automation settings while the recoverable health probe is still pending', async () => {
    const initialHealth = deferred<BrowserBackendHealth>();
    api.getBackendHealth.mockReturnValueOnce(initialHealth.promise);

    render(<ComputerUseSection workingDir="/tmp/project" />);

    expect(await screen.findByText('settings.computerUse.title')).toBeTruthy();
    expect(screen.getByRole('tab', {
      name: 'settings.computerUse.browserBackend.rsbWebview.title',
    })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('tab', {
      name: 'settings.computerUse.browserBackend.external.title',
    }));
    await waitFor(() => expect(api.setBackendKind).toHaveBeenCalledWith('external'));
    await waitFor(() => expect(
      screen.getByRole('tab', {
        name: 'settings.computerUse.browserBackend.external.title',
      }).getAttribute('aria-selected'),
    ).toBe('true'));

    fireEvent.click(screen.getByRole('tab', {
      name: 'settings.computerUse.browserBackend.rsbWebview.title',
    }));
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
