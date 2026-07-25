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

  it('keeps pointer tilt outside React state and animates only the edge transform', () => {
    expect(source).toContain('onPointerMove={handleQrPointerMove}');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('perspective(760px)');
    expect(source).toContain('scale3d(1.018, 1.018, 1.018)');
    expect(source).not.toContain('const [qrPointer');
    expect(source).not.toContain('setQrAutoAngle');
    expect(globalStyles).toContain('@keyframes mobile-download-edge-turn');
    expect(globalStyles).toContain(
      'animation: mobile-download-edge-turn var(--mobile-download-edge-cycle) linear infinite',
    );
    expect(globalStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(globalStyles).toMatch(/\.mobile-download-qr-edge\s*\{\s*animation: none;\s*transform:/);
  });

  it('keeps the QR size transition alive while the pointer is on the card', () => {
    // 指针停在卡上时设备列表可能刚好刷新:transform 要逐帧跟手,但 228px ↔ 132px
    // 仍必须补间,不能整条 transition 关掉。
    const pointerActiveRule = globalStyles.slice(
      globalStyles.indexOf(".mobile-download-qr-card[data-pointer-active='true'] {"),
      globalStyles.indexOf('.mobile-download-qr-edge {'),
    );
    expect(pointerActiveRule).not.toMatch(/transition:\s*none/);
    expect(pointerActiveRule).toMatch(/transition:[^}]*width var\(--motion-base\)/);
    expect(pointerActiveRule).toMatch(/transition:[^}]*height var\(--motion-base\)/);
    expect(pointerActiveRule).not.toMatch(/transition:[^}]*transform var\(/);
  });

  it('keeps the flowing edge free of per-frame filters and self-authored brand color', () => {
    // 红蓝只能来自官方 icon 资产(不自写品牌渐变/色值),且常驻动画必须是纯 transform:
    // 一旦给这层挂 filter/blur,旋转就每帧重走滤镜通道,常驻动效开始吃机器。
    expect(source).not.toMatch(/linear-gradient|conic-gradient|#[0-9a-fA-F]{3,8}\b/);
    const edgeRule = globalStyles.slice(
      globalStyles.indexOf('.mobile-download-qr-edge {'),
      globalStyles.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    expect(edgeRule).not.toMatch(/filter:|backdrop-filter:|mask-image:/);
  });

  it('queues one mouse-tilt frame and cancels it when the dialog unmounts', () => {
    const requestFrame = vi.fn(() => 37);
    const cancelFrame = vi.fn();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: requestFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: cancelFrame,
    });

    const view = render(
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
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 236,
      bottom: 236,
      left: 0,
      width: 236,
      height: 236,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(card, {
      pointerType: 'mouse',
      clientX: 180,
      clientY: 80,
    });

    expect(card.dataset.pointerActive).toBe('true');
    expect(requestFrame).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(37);
  });

  it('does not queue pointer motion when reduced motion is requested', () => {
    const requestFrame = vi.fn(() => 37);
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: requestFrame,
    });
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

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
    fireEvent.pointerMove(screen.getByTestId('mobile-download-qr-card'), {
      pointerType: 'mouse',
      clientX: 180,
      clientY: 80,
    });

    expect(requestFrame).not.toHaveBeenCalled();
  });
});
