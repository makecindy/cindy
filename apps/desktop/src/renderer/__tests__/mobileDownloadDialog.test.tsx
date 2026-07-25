// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,mobile-download'),
}));
vi.mock('qrcode', () => ({ toDataURL }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import {
  MobileDownloadDialog,
  resolveMobileRemotePresentation,
  resolveMobileDownloadUrl,
} from '@/components/sidebar/MobileDownloadDialog';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'sidebar', 'MobileDownloadDialog.tsx'),
  'utf8',
);
const globalStyles = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const themeColors = readFileSync(resolve(__dirname, '..', 'themes', 'colors.ts'), 'utf8');

const openExternal = vi.fn(async () => ({ success: true }));
type DeviceLinkState = Awaited<ReturnType<ElectronAPI['deviceLink']['getState']>>;
const getState = vi.fn<() => Promise<DeviceLinkState>>(async () => ({
  remoteControlEnabled: true,
  keepAwake: false,
  linkStatus: 'online',
  connectionIssue: null,
  controlledBy: [],
  revokedControllers: [],
  disabledControlDeviceIds: [],
}));
const listDevices = vi.fn(async () => ({
  devices: [
    {
      deviceId: 'desktop-device-1',
      name: 'Studio Mac',
      platform: 'darwin',
      appVersion: '1.0.0',
      lastSeenAt: null,
      online: true,
      busy: false,
      remoteControlEnabled: true,
      controlEnabled: true,
      isSelf: true,
    },
    {
      deviceId: 'mobile-device-1',
      name: 'My iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
      lastSeenAt: null,
      online: true,
      busy: false,
      remoteControlEnabled: false,
      controlEnabled: true,
      isSelf: false,
    },
  ],
}));
let presenceChangedHandler: (() => void) | undefined;
const onPresenceChanged = vi.fn((handler: () => void) => {
  presenceChangedHandler = handler;
  return vi.fn();
});
const onStatusChanged = vi.fn(() => vi.fn());
const onConnectionIssue = vi.fn(() => vi.fn());
const detachedTriggerRef = { current: null as HTMLButtonElement | null };

beforeEach(() => {
  toDataURL.mockClear();
  toastError.mockClear();
  openExternal.mockClear();
  getState.mockClear();
  listDevices.mockClear();
  presenceChangedHandler = undefined;
  onPresenceChanged.mockClear();
  onStatusChanged.mockClear();
  onConnectionIssue.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      clientEndpoints: { websiteUrl: 'https://cindy.cn' },
      openExternal,
      deviceLink: {
        getState,
        listDevices,
        onPresenceChanged,
        onStatusChanged,
        onConnectionIssue,
      },
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(window.performance.now()), 0),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (frameId: number) => window.clearTimeout(frameId),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('resolveMobileDownloadUrl', () => {
  it('builds the all-versions page from the regional website endpoint', () => {
    expect(resolveMobileDownloadUrl('https://cindy.cn')).toBe(
      'https://cindy.cn/download/#all-versions',
    );
    expect(resolveMobileDownloadUrl('https://cindy.app')).toBe(
      'https://cindy.app/download/#all-versions',
    );
  });

  it('keeps the shipped endpoint hosts intact', () => {
    // 打包配置里的真实取值:CN 是 config/endpoint.json 的 cindy.com.cn(官网 302 到
    // cindy.cn/download/),Global 是 cindy.app。这里不做域名改写,区域来源只有
    // clientEndpoints 一处。
    for (const configPath of [
      '../../../../../config/endpoint.json',
      '../../../../../config/endpoint.global.json',
    ]) {
      const websiteUrl = JSON.parse(
        readFileSync(resolve(__dirname, configPath), 'utf8'),
      ).websiteUrl;
      expect(resolveMobileDownloadUrl(websiteUrl)).toBe(`${websiteUrl}/download/#all-versions`);
    }
  });

  it.each(['', 'not-a-url', 'http://cindy.cn', 'https://user:pass@cindy.cn'])(
    'rejects an unsafe regional website endpoint: %s',
    (websiteUrl) => {
      expect(resolveMobileDownloadUrl(websiteUrl)).toBeNull();
    },
  );
});

describe('resolveMobileRemotePresentation', () => {
  const selfDevice = {
    deviceId: 'desktop-device-1',
    name: 'Studio Mac',
    platform: 'darwin',
    appVersion: null,
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: true,
  };

  it('keeps permission state separate from the mobile-linked layout', () => {
    expect(
      resolveMobileRemotePresentation({
        enabled: false,
        devices: [selfDevice],
      }),
    ).toMatchObject({
      layout: 'onboarding',
      remoteEnabled: false,
      linkedMobileCount: 0,
      otherDeviceCount: 0,
      selfDeviceId: 'desktop-device-1',
    });
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        devices: [
          selfDevice,
          {
            ...selfDevice,
            deviceId: 'desktop-2',
            name: 'Other desktop',
            isSelf: false,
          },
        ],
      }),
    ).toMatchObject({
      layout: 'onboarding',
      remoteEnabled: true,
      linkedMobileCount: 0,
      otherDeviceCount: 1,
    });
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        devices: [
          selfDevice,
          {
            ...selfDevice,
            deviceId: 'mobile-1',
            name: 'My iPhone',
            platform: 'ios',
            isSelf: false,
          },
        ],
      }),
    ).toMatchObject({
      layout: 'linked',
      remoteEnabled: true,
      linkedMobileCount: 1,
      otherDeviceCount: 1,
      selfDeviceId: 'desktop-device-1',
      linkedMobileName: 'My iPhone',
    });
  });

  it('orders the preview mobile-first and then by name, without relying on sort stability', () => {
    const other = (deviceId: string, name: string, platform: string) => ({
      ...selfDevice,
      deviceId,
      name,
      platform,
      isSelf: false,
    });

    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        devices: [
          selfDevice,
          other('d-1', 'Zeta desktop', 'win32'),
          other('m-1', 'Zeta phone', 'ios'),
          other('d-2', 'Alpha desktop', 'linux'),
          other('m-2', 'Alpha phone', 'android'),
        ],
      }).previewDevices.map((device) => device.deviceId),
    ).toEqual(['m-2', 'm-1', 'd-2']);
  });

  it('keeps an unavailable device list distinct from a confirmed empty list', () => {
    expect(
      resolveMobileRemotePresentation({
        enabled: true,
        devices: null,
      }),
    ).toMatchObject({
      layout: 'checking',
      remoteEnabled: true,
      selfDeviceId: null,
    });
  });
});

describe('MobileDownloadDialog', () => {
  it('warms the QR code and remote snapshot before the dialog opens', async () => {
    render(
      <MobileDownloadDialog
        open={false}
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );
    await waitFor(() => expect(toDataURL).toHaveBeenCalledTimes(1));
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('generates the regional QR code and exposes an equivalent browser action', async () => {
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    expect(await screen.findByAltText('sidebar.mobileDownload.qrAlt')).toBeTruthy();

    const openButton = screen.getByRole('button', {
      name: 'sidebar.mobileDownload.openPage',
    });
    await waitFor(() => expect(document.activeElement).toBe(openButton));
    fireEvent.click(openButton);
    expect(openExternal).toHaveBeenCalledWith('https://cindy.cn/download/#all-versions');
  });

  it('reports a failed handoff to the system browser', async () => {
    openExternal.mockResolvedValueOnce({ success: false });
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sidebar.mobileDownload.openPage' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('sidebar.mobileDownload.openFailed'),
    );

    toastError.mockClear();
    openExternal.mockRejectedValueOnce(new Error('ipc down'));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.mobileDownload.openPage' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('sidebar.mobileDownload.openFailed'),
    );
  });

  it('re-reads the remote state every time the dialog reopens', async () => {
    // 设置页改权限、重命名/删除设备都不经过 presence/status/connection-issue 推送,
    // 重新打开必须自己重读一次。
    const props = {
      onOpenChange: vi.fn(),
      remoteAvailable: true,
      onOpenRemoteSettings: vi.fn(),
      onOpenDevices: vi.fn(),
      triggerRef: detachedTriggerRef,
    };
    const view = render(<MobileDownloadDialog open={false} {...props} />);
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));

    view.rerender(<MobileDownloadDialog open {...props} />);
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));

    view.rerender(<MobileDownloadDialog open={false} {...props} />);
    view.rerender(<MobileDownloadDialog open {...props} />);
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(3));
  });

  it('shows the compact QR, device preview, and separate settings actions when mobile is linked', async () => {
    const onOpenRemoteSettings = vi.fn();
    const onOpenDevices = vi.fn();
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={onOpenRemoteSettings}
        onOpenDevices={onOpenDevices}
        triggerRef={detachedTriggerRef}
      />,
    );

    expect(await screen.findByText('sidebar.mobileDownload.myDevices')).toBeTruthy();
    expect(screen.getByText('My iPhone')).toBeTruthy();
    expect(screen.getByText('sidebar.mobileDownload.deviceId')).toBeTruthy();
    expect(screen.getByTestId('mobile-download-qr-card').dataset.compact).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /sidebar\.mobileDownload\.myDevices/ }));
    expect(onOpenDevices).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /sidebar\.mobileDownload\.allowControl/ }));
    expect(onOpenRemoteSettings).toHaveBeenCalledTimes(1);
  });

  it('preserves the linked layout when a later device-list refresh fails', async () => {
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('mobile-download-qr-card').dataset.compact).toBe('true'),
    );
    listDevices.mockRejectedValueOnce(new Error('temporary list failure'));
    await act(async () => {
      presenceChangedHandler?.();
    });
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('mobile-download-qr-card').dataset.compact).toBe('true');
    expect(screen.getByText('My iPhone')).toBeTruthy();
  });

  it('keeps the newest remote snapshot when event-driven refreshes resolve out of order', async () => {
    let resolveStaleState!: (state: Awaited<ReturnType<typeof getState>>) => void;
    const staleState = {
      remoteControlEnabled: false,
      keepAwake: false,
      linkStatus: 'connecting' as const,
      connectionIssue: null,
      controlledBy: [],
      revokedControllers: [],
      disabledControlDeviceIds: [],
    };
    getState
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleState = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...staleState,
        remoteControlEnabled: true,
        linkStatus: 'online',
      });

    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    await waitFor(() => expect(presenceChangedHandler).toBeTypeOf('function'));
    await act(async () => {
      presenceChangedHandler?.();
    });
    expect(await screen.findByText('sidebar.mobileDownload.remoteAction.enabled')).toBeTruthy();

    await act(async () => {
      resolveStaleState(staleState);
    });
    await waitFor(() =>
      expect(screen.getByText('sidebar.mobileDownload.remoteAction.enabled')).toBeTruthy(),
    );
    expect(screen.queryByText('sidebar.mobileDownload.remoteAction.enable')).toBeNull();
  });

  it('keeps the settings path available when the remote state cannot be read', async () => {
    getState.mockRejectedValueOnce(new Error('state unavailable'));
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    expect(await screen.findByText('sidebar.mobileDownload.remoteAction.unavailable')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /sidebar\.mobileDownload\.allowControl/ }),
    ).toBeTruthy();
  });

  it('drops the enabled dot once the remote state read fails', async () => {
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    const readyDot = () =>
      screen
        .getByRole('button', { name: /sidebar\.mobileDownload\.allowControl/ })
        .querySelector('[class*="--remote-status-ready"]');

    expect(await screen.findByText('sidebar.mobileDownload.remoteAction.enabled')).toBeTruthy();
    expect(readyDot()).toBeTruthy();

    getState.mockRejectedValueOnce(new Error('state unavailable'));
    await waitFor(() => expect(presenceChangedHandler).toBeTypeOf('function'));
    await act(async () => {
      presenceChangedHandler?.();
    });

    expect(await screen.findByText('sidebar.mobileDownload.remoteAction.unavailable')).toBeTruthy();
    // 陈旧的 enabled 快照不能和「暂不可用」文案同时出现。
    expect(readyDot()).toBeNull();
  });

  it('uses the official Cindy artwork and the shared dialog tokens', () => {
    expect(source).toContain('@/../../resources/icon.png?url');
    expect(source).toContain("t('sidebar.mobileDownload.title')");
    expect(source).toContain('<Smartphone');
    expect(source).toContain('<Monitor');
    expect(source).toContain("t('sidebar.mobileDownload.subtitle')");
    expect(source).toContain('bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]');
    expect(source).not.toMatch(/(?:linear|conic|radial)-gradient/);
    expect(source).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });

  it('focuses a usable fallback when the download endpoint is invalid', async () => {
    window.electronAPI.clientEndpoints.websiteUrl = 'not-a-url';
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /sidebar\.mobileDownload\.allowControl/ }),
      ),
    );
  });

  it('returns focus to the sidebar trigger when the dialog closes', async () => {
    function FocusReturnHarness() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            download trigger
          </button>
          <MobileDownloadDialog
            open={open}
            onOpenChange={setOpen}
            remoteAvailable
            onOpenRemoteSettings={vi.fn()}
            onOpenDevices={vi.fn()}
            triggerRef={triggerRef}
          />
        </>
      );
    }

    render(<FocusReturnHarness />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'sidebar.mobileDownload.close',
      }),
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'download trigger' })),
    );
  });

  it('keeps the QR card flat per the design rules', () => {
    // DESIGN.md §7:不加阴影、不放装饰性品牌图形;§14.4:不做常驻/循环装饰动效。
    // 这三条曾被「旋转 app icon 折射边 + 卡片阴影 + 指针 3D 倾斜」违反,
    // 回归后这里直接把契约钉死。
    expect(source).not.toMatch(/mobile-download-qr-edge|onPointerMove|requestAnimationFrame/);
    // Dialog 容器本身仍用 §4 授权的 --confirm-shadow;这里只禁二维码卡自带阴影。
    expect(source).not.toMatch(/perspective\(|scale3d\(|mobile-download-qr-shadow/);
    expect(source).not.toMatch(/linear-gradient|conic-gradient|#[0-9a-fA-F]{3,8}\b/);
    expect(globalStyles).not.toMatch(/mobile-download-edge-turn|mobile-download-qr-edge/);
    expect(globalStyles).not.toMatch(/--mobile-download-qr-shadow/);
    expect(themeColors).not.toMatch(/mobile-download-qr-shadow/);

    const cardRule = globalStyles.slice(
      globalStyles.indexOf('.mobile-download-qr-card {'),
      globalStyles.indexOf('/* 按 <html lang> 切换 CJK 字体栈'),
    );
    expect(cardRule).not.toMatch(/box-shadow|animation:|transform:/);
    // 唯一保留的动效:linked ↔ onboarding 的尺寸补间(§14.4 size change 档)。
    expect(cardRule).toMatch(
      /transition:\s*\n\s*width var\(--motion-base\) var\(--motion-ease-move\),/,
    );
    expect(cardRule).toMatch(/height var\(--motion-base\) var\(--motion-ease-move\);/);
  });

  it('renders the QR card as a single flat bordered surface', () => {
    render(
      <MobileDownloadDialog
        open
        onOpenChange={vi.fn()}
        remoteAvailable={false}
        onOpenRemoteSettings={vi.fn()}
        onOpenDevices={vi.fn()}
        triggerRef={detachedTriggerRef}
      />,
    );

    const card = screen.getByTestId('mobile-download-qr-card');
    expect(card.className).toContain('border border-[var(--border-default)]');
    expect(card.querySelectorAll('img')).toHaveLength(1);
  });
});
