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
  it('builds the download page from the regional website endpoint', () => {
    expect(resolveMobileDownloadUrl('https://cindy.cn')).toBe('https://cindy.cn/download/');
    expect(resolveMobileDownloadUrl('https://cindy.app')).toBe('https://cindy.app/download/');
  });

  it('maps the shipped endpoint hosts onto the canonical download pages', () => {
    // 打包配置的真实取值:CN 是 config/endpoint.json 的 cindy.com.cn(官网 302 到
    // cindy.cn),Global 是 cindy.app。二维码直接给最终地址,手机上少一跳。
    const shipped = (configPath: string) =>
      JSON.parse(readFileSync(resolve(__dirname, configPath), 'utf8')).websiteUrl as string;

    expect(resolveMobileDownloadUrl(shipped('../../../../../config/endpoint.json'))).toBe(
      'https://cindy.cn/download/',
    );
    expect(resolveMobileDownloadUrl(shipped('../../../../../config/endpoint.global.json'))).toBe(
      'https://cindy.app/download/',
    );
  });

  it('accepts the loopback http endpoint used by the dev manifest', () => {
    // config/endpoint.dev.json.example 的 websiteUrl 是 http://localhost:3000,
    // 开发机不该看到一个禁用的二维码。
    expect(resolveMobileDownloadUrl('http://localhost:3000')).toBe(
      'http://localhost:3000/download/',
    );
    expect(resolveMobileDownloadUrl('http://127.0.0.1:5173')).toBe(
      'http://127.0.0.1:5173/download/',
    );
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
    expect(openExternal).toHaveBeenCalledWith('https://cindy.cn/download/');
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

  it('retries QR generation when the dialog is reopened after a failure', async () => {
    // 用独立站点绕开模块级二维码缓存(缓存按 URL 命中,复用 cindy.cn 会直接拿到
    // 前面用例生成好的结果,失败路径根本走不到)。
    window.electronAPI.clientEndpoints.websiteUrl = 'https://qr-retry.example.com';
    toDataURL.mockRejectedValueOnce(new Error('canvas busy'));
    const props = {
      onOpenChange: vi.fn(),
      remoteAvailable: false,
      onOpenRemoteSettings: vi.fn(),
      onOpenDevices: vi.fn(),
      triggerRef: detachedTriggerRef,
    };
    const view = render(<MobileDownloadDialog open {...props} />);

    expect(await screen.findByText('sidebar.mobileDownload.error')).toBeTruthy();

    view.rerender(<MobileDownloadDialog open={false} {...props} />);
    view.rerender(<MobileDownloadDialog open {...props} />);

    expect(await screen.findByAltText('sidebar.mobileDownload.qrAlt')).toBeTruthy();
  });

  it('subscribes to Device Link pushes only while the dialog is open', async () => {
    const props = {
      onOpenChange: vi.fn(),
      remoteAvailable: true,
      onOpenRemoteSettings: vi.fn(),
      onOpenDevices: vi.fn(),
      triggerRef: detachedTriggerRef,
    };
    const view = render(<MobileDownloadDialog open={false} {...props} />);
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    expect(onPresenceChanged).not.toHaveBeenCalled();

    view.rerender(<MobileDownloadDialog open {...props} />);
    expect(onPresenceChanged).toHaveBeenCalledTimes(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(onConnectionIssue).toHaveBeenCalledTimes(1);
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

  it('keeps the QR card flat with no brand edge', () => {
    // 二维码卡回到 DESIGN.md 的中性处理:没有品牌描边、没有阴影、没有指针 3D 倾斜,
    // 也没有常驻动画(§14.4 红线);唯一动效是 linked ↔ onboarding 的尺寸补间。
    expect(source).not.toMatch(/perspective\(|scale3d\(|onPointerMove|requestAnimationFrame/);
    expect(source).not.toMatch(/mobile-download-qr-shadow/);
    expect(globalStyles).not.toMatch(/--mobile-download-qr-shadow/);
    expect(themeColors).not.toMatch(/mobile-download-qr-shadow/);
    // 不自写品牌渐变/色值。
    expect(source).not.toMatch(/linear-gradient|conic-gradient|#[0-9a-fA-F]{3,8}\b/);

    // 折射边整层撤除:组件、keyframes、周期 token 都不该再留残骸。
    expect(source).not.toMatch(/mobile-download-qr-edge/);
    expect(globalStyles).not.toMatch(
      /mobile-download-qr-edge|mobile-download-edge-turn|--mobile-download-edge-cycle/,
    );
    // 官方 icon 只剩弹窗头部这一处(import + 一次使用)。
    expect(source.match(/cindyIconUrl/g)).toHaveLength(2);

    const cardStart = globalStyles.indexOf('.mobile-download-qr-card {');
    const cardRule = globalStyles.slice(cardStart, globalStyles.indexOf('}', cardStart) + 1);
    expect(cardRule).not.toMatch(/box-shadow|animation:|transform:|border/);
    expect(cardRule).toMatch(
      /transition:\s*\n\s*width var\(--motion-base\) var\(--motion-ease-move\),/,
    );
    expect(cardRule).toMatch(/height var\(--motion-base\) var\(--motion-ease-move\);/);
  });

  it('renders the QR as the only image inside the card', async () => {
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

    await screen.findByAltText('sidebar.mobileDownload.qrAlt');
    const card = screen.getByTestId('mobile-download-qr-card');
    expect(card.querySelector('.mobile-download-qr-edge')).toBeNull();
    const images = card.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('alt')).toBe('sidebar.mobileDownload.qrAlt');
  });
});
