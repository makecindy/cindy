// @vitest-environment jsdom

/**
 * Issue #1806 回归:Android 自动化插件禁用时,打开「电脑使用」面板不得触发
 * 任何 adb 探测(status() 会跑 `adb devices -l`,5037 无 server 时会顺手 fork
 * 一个 daemon)。禁用态只展示提示文案;启用态保持原有 prepareAdb → status 链路。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { ComputerUseSection } from '../ComputerUseSection';

function installElectronApi(options: { androidEnabled: boolean }) {
  const androidStatus = vi.fn(async () => ({
    adb_available: true,
    adb_path: '/sdk/platform-tools/adb',
    adb_path_source: 'sdk',
    version: 'Android Debug Bridge version 1.0.41',
    devices: [],
    default_device_serial: null,
    configured_default_device_serial: null,
    issue: 'NO_DEVICE',
    error: null,
  }));
  const androidPrepareAdb = vi.fn(async () => ({ status: 'ready', source: 'sdk' }));
  const androidGetConfig = vi.fn(async () => ({
    value: { defaultDeviceSerial: null, adbPathOverride: null },
  }));
  const pluginsGetState = vi.fn(async (pluginId: string) => ({
    pluginId,
    effectiveEnabled: pluginId === 'android' ? options.androidEnabled : false,
  }));

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      openExternal: vi.fn(async () => ({ success: true })),
      maker: {
        plugins: {
          getState: pluginsGetState,
          setEnabled: vi.fn(async () => ({ codexMcpRefreshed: true })),
          setProjectEnabled: vi.fn(),
        },
        browser: {
          status: vi.fn(async () => ({
            detected: false,
            browserKind: null,
            executablePath: null,
          })),
        },
        computer: {
          status: vi.fn(async () => ({
            installed: false,
            executablePath: null,
            version: null,
            daemonRunning: false,
            installCommand: 'noop',
            docsUrl: 'https://example.invalid/docs',
          })),
          checkUpdate: vi.fn(async () => ({ updateAvailable: false, updating: false })),
          onPermissionGuideStatusChanged: vi.fn(() => () => {}),
          onPermissionGuideCancelled: vi.fn(() => () => {}),
          onUpdateProgress: vi.fn(() => () => {}),
          cancelPermissionGrant: vi.fn(async () => {}),
        },
        android: {
          getConfig: androidGetConfig,
          status: androidStatus,
          prepareAdb: androidPrepareAdb,
          setDefaultDevice: vi.fn(),
          setAdbPath: vi.fn(),
        },
      },
    } as unknown as Window['electronAPI'],
  });

  return { androidStatus, androidPrepareAdb, androidGetConfig, pluginsGetState };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
  vi.clearAllMocks();
});

describe('ComputerUseSection android disabled gate (#1806)', () => {
  it('does not probe adb on mount while the android plugin is disabled', async () => {
    const api = installElectronApi({ androidEnabled: false });

    render(<ComputerUseSection workingDir="/repo" />);

    // 等 mount 数据链路完全落地(插件状态 + 配置都已返回)再断言。
    await waitFor(() => {
      expect(api.pluginsGetState).toHaveBeenCalledWith('android');
    });
    await waitFor(() => {
      expect(
        screen.getByText('settings.computerUse.android.status.disabled'),
      ).toBeTruthy();
    });

    // 核心断言:禁用态 mount 绝不触碰 adb(status 会拉起 adb server)。
    expect(api.androidStatus).not.toHaveBeenCalled();
    expect(api.androidPrepareAdb).not.toHaveBeenCalled();
    // 纯设置读取不受影响。
    expect(api.androidGetConfig).toHaveBeenCalled();
  });

  it('keeps prepareAdb → status probing on mount when the android plugin is enabled', async () => {
    const api = installElectronApi({ androidEnabled: true });

    render(<ComputerUseSection workingDir="/repo" />);

    await waitFor(() => {
      expect(api.androidStatus).toHaveBeenCalledOnce();
    });
    expect(api.androidPrepareAdb).toHaveBeenCalledOnce();
    // prepareAdb 先于 status:status 必须消费准备完成后的 adb 解析结果。
    const prepareOrder = api.androidPrepareAdb.mock.invocationCallOrder[0]!;
    const statusOrder = api.androidStatus.mock.invocationCallOrder[0]!;
    expect(prepareOrder).toBeLessThan(statusOrder);
    // 启用态不显示禁用提示。
    expect(
      screen.queryByText('settings.computerUse.android.status.disabled'),
    ).toBeNull();
  });

  it('clears the stale probe result when the android plugin is toggled off', async () => {
    const api = installElectronApi({ androidEnabled: true });

    render(<ComputerUseSection workingDir="/repo" />);

    await waitFor(() => {
      expect(api.androidStatus).toHaveBeenCalledOnce();
    });

    fireEvent.click(
      screen.getByRole('switch', { name: 'settings.computerUse.android.toggleAria' }),
    );

    // 关闭后状态区回到禁用提示,不残留旧的就绪/设备状态。
    await waitFor(() => {
      expect(
        screen.getByText('settings.computerUse.android.status.disabled'),
      ).toBeTruthy();
    });
    // 关闭动作本身不得触发新的 adb 探测。
    expect(api.androidStatus).toHaveBeenCalledOnce();
    expect(api.androidPrepareAdb).toHaveBeenCalledOnce();
  });
});
